package online.camstream.agent.discovery;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.w3c.dom.Document;
import org.w3c.dom.Element;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Base64;

/**
 * The slice of ONVIF needed to turn a discovered device into playable RTSP URLs:
 * device information, media profiles, and a stream URI per profile.
 *
 * Deliberately hand-rolled rather than generated from the WSDL. The full ONVIF
 * stack is enormous, and the alternative Java bindings pull in a media library
 * carrying a GPL FFmpeg build — see docs/licensing.md.
 */
final class OnvifClient {

    private static final Logger log = LoggerFactory.getLogger(OnvifClient.class);

    private static final String DEVICE_NS = "http://www.onvif.org/ver10/device/wsdl";
    private static final java.util.regex.Pattern MAC_ADDRESS =
            java.util.regex.Pattern.compile("([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}");
    private static final String MEDIA_NS = "http://www.onvif.org/ver10/media/wsdl";
    private static final String MEDIA2_NS = "http://www.onvif.org/ver20/media/wsdl";

    /**
     * Media2 (ONVIF Profile T) is not a superset of Media1 — it renames the
     * elements and, crucially, returns profiles with an empty Configurations
     * element unless a Type is requested. A real CP Plus camera answered
     * GetProfiles with nothing at all until asked for Type=All.
     */
    private static boolean isMedia2(String serviceUrl) {
        return serviceUrl != null && serviceUrl.contains("media2");
    }

    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    private final SecureRandom random = new SecureRandom();

    /** Raised when the device answered but refused the credentials. */
    static final class AuthenticationFailed extends Exception {
        AuthenticationFailed(String message) {
            super(message);
        }
    }

    /**
     * ONVIF authenticates with a WS-Security UsernameToken carrying
     * Base64(SHA1(nonce + created + password)) rather than the password itself.
     */
    private String securityHeader(String username, String password) {
        if (username == null || username.isBlank()) {
            return "";
        }
        byte[] nonce = new byte[16];
        random.nextBytes(nonce);
        String created = DateTimeFormatter.ISO_INSTANT.format(Instant.now());
        String digest;
        try {
            MessageDigest sha1 = MessageDigest.getInstance("SHA-1");
            sha1.update(nonce);
            sha1.update(Xml.utf8(created));
            sha1.update(Xml.utf8(password == null ? "" : password));
            digest = Base64.getEncoder().encodeToString(sha1.digest());
        } catch (Exception e) {
            throw new IllegalStateException("SHA-1 unavailable", e);
        }
        return """
            <s:Header>
              <Security xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">
                <UsernameToken>
                  <Username>%s</Username>
                  <Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">%s</Password>
                  <Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">%s</Nonce>
                  <Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">%s</Created>
                </UsernameToken>
              </Security>
            </s:Header>
            """.formatted(escape(username), digest,
                Base64.getEncoder().encodeToString(nonce), created);
    }

    private Document call(String serviceUrl, String namespace, String body, String username, String password)
            throws Exception {
        String envelope = """
            <?xml version="1.0" encoding="UTF-8"?>
            <s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:t="%s">
              %s
              <s:Body>%s</s:Body>
            </s:Envelope>
            """.formatted(namespace, securityHeader(username, password), body);

        HttpRequest request = HttpRequest.newBuilder(URI.create(serviceUrl))
                .timeout(Duration.ofSeconds(10))
                .header("Content-Type", "application/soap+xml; charset=utf-8")
                .POST(HttpRequest.BodyPublishers.ofByteArray(Xml.utf8(envelope)))
                .build();

        HttpResponse<byte[]> response = http.send(request, HttpResponse.BodyHandlers.ofByteArray());
        if (response.statusCode() == 401 || response.statusCode() == 403) {
            throw new AuthenticationFailed("HTTP " + response.statusCode());
        }
        Document document = Xml.parse(response.body());
        // ONVIF reports auth failure as a 500 with a SOAP Fault, not a 401.
        Element fault = Xml.firstElement(document, "Fault");
        if (fault != null) {
            String reason = Xml.text(fault, "Text");
            if (reason != null && reason.toLowerCase().matches(".*(auth|denied|password|subcode).*")) {
                throw new AuthenticationFailed(reason);
            }
            throw new IllegalStateException("ONVIF fault: " + reason);
        }
        return document;
    }

    void fillDeviceInformation(DiscoveredCamera camera, String username, String password) throws Exception {
        Document response = call(camera.onvifServiceUrl, DEVICE_NS,
                "<t:GetDeviceInformation/>", username, password);
        camera.manufacturer = Xml.text(response, "Manufacturer");
        camera.model = Xml.text(response, "Model");
        camera.firmware = Xml.text(response, "FirmwareVersion");
        camera.serialNumber = Xml.text(response, "SerialNumber");
    }

    /**
     * The camera's own hardware address, asked of the camera itself.
     *
     * ARP is the cheaper source but only sees the local segment: a camera one
     * routed hop away has no ARP entry at all, and on a site of any size most
     * of them are. The camera knows its own MAC regardless of how far away it
     * is, so this is what makes a hardware-address identity usable beyond a
     * flat network.
     *
     * Returns null rather than throwing: some firmware restricts
     * GetNetworkInterfaces to an administrator account, and a viewer-level
     * credential failing here is ordinary, not an error.
     */
    String hardwareAddress(DiscoveredCamera camera, String username, String password) {
        try {
            Document response = call(camera.onvifServiceUrl, DEVICE_NS,
                    "<t:GetNetworkInterfaces/>", username, password);

            // A camera can report several interfaces — a wired one and a
            // wireless one, and sometimes a disabled interface with a zeroed
            // address. Enabled first, and never a zero address, or two cameras
            // would agree on the same identity.
            // The specification names the repeated element "NetworkInterfaces",
            // plural, even though each one describes a single interface. The
            // singular is accepted too: firmware gets this wrong both ways.
            List<Element> interfaces = new ArrayList<>(Xml.elements(response, "NetworkInterfaces"));
            interfaces.addAll(Xml.elements(response, "NetworkInterface"));

            String fallback = null;
            for (Element iface : interfaces) {
                String mac = Xml.text(iface, "HwAddress");
                if (mac == null || !MAC_ADDRESS.matcher(mac.trim()).matches()) {
                    continue;
                }
                String normalised = mac.trim().replace('-', ':').toLowerCase(Locale.ROOT);
                if (normalised.equals("00:00:00:00:00:00")) {
                    continue;
                }
                if ("true".equalsIgnoreCase(Xml.text(iface, "Enabled"))) {
                    return normalised;
                }
                if (fallback == null) {
                    fallback = normalised;
                }
            }
            return fallback;
        } catch (Exception e) {
            log.debug("GetNetworkInterfaces failed for {}: {}", camera.ipAddress, e.toString());
            return null;
        }
    }

    /** Media service endpoint, which is frequently not the device endpoint. */
    String mediaServiceUrl(DiscoveredCamera camera, String username, String password) {
        try {
            Document response = call(camera.onvifServiceUrl, DEVICE_NS,
                    "<t:GetServices><t:IncludeCapability>false</t:IncludeCapability></t:GetServices>",
                    username, password);
            // Prefer Media2 where the device offers both: it is the current
            // specification, and a device implementing it may leave the ver10
            // service present but unmaintained.
            String media1 = null;
            for (Element service : Xml.elements(response, "Service")) {
                String namespace = Xml.text(service, "Namespace");
                String address = Xml.text(service, "XAddr");
                if (namespace == null || address == null || address.isBlank()) {
                    continue;
                }
                if (namespace.equals(MEDIA2_NS)) {
                    return address;
                }
                if (namespace.equals(MEDIA_NS)) {
                    media1 = address;
                }
            }
            if (media1 != null) {
                return media1;
            }
        } catch (Exception e) {
            log.debug("GetServices failed for {}: {}", camera.ipAddress, e.toString());
        }
        // Older devices only implement the ver10 media service at a fixed path.
        return camera.onvifServiceUrl.replaceAll("/onvif/.*$", "/onvif/media_service");
    }

    void fillProfiles(DiscoveredCamera camera, String mediaUrl, String username, String password) throws Exception {
        boolean media2 = isMedia2(mediaUrl);
        // Without an explicit Type, a Media2 device is entitled to return
        // profiles carrying no configuration at all — and some do.
        Document response = call(
                mediaUrl,
                media2 ? MEDIA2_NS : MEDIA_NS,
                media2 ? "<t:GetProfiles><t:Type>All</t:Type></t:GetProfiles>" : "<t:GetProfiles/>",
                username, password);

        for (Element profile : Xml.elements(response, "Profiles")) {
            String token = profile.getAttribute("token");
            if (token == null || token.isBlank()) {
                continue;
            }
            DiscoveredCamera.DiscoveredProfile found = new DiscoveredCamera.DiscoveredProfile();
            found.token = token;
            found.name = Xml.text(profile, "Name");

            // Media1 calls it VideoEncoderConfiguration, Media2 calls it
            // VideoEncoder. Accept either rather than branching on a version
            // the device may report inconsistently.
            Element videoEncoder = Xml.firstElement(profile, "VideoEncoderConfiguration");
            if (videoEncoder == null) {
                videoEncoder = Xml.firstElement(profile, "VideoEncoder");
            }
            if (videoEncoder != null) {
                found.codec = normaliseCodec(Xml.text(videoEncoder, "Encoding"));
                Element resolution = Xml.firstElement(videoEncoder, "Resolution");
                if (resolution != null) {
                    found.width = Xml.integer(resolution, "Width");
                    found.height = Xml.integer(resolution, "Height");
                }
                Element rate = Xml.firstElement(videoEncoder, "RateControl");
                if (rate != null) {
                    found.fps = Xml.integer(rate, "FrameRateLimit");
                    found.bitrateKbps = Xml.integer(rate, "BitrateLimit");
                }
                // Media2 reports the GOP length as an attribute. Worth having:
                // the agent stream-copies, so it can only cut a segment on a
                // keyframe, and a GOP longer than the segment duration silently
                // produces longer segments and more latency.
                String govLength = videoEncoder.getAttribute("GovLength");
                if (govLength != null && !govLength.isBlank()) {
                    try {
                        found.gopFrames = Integer.parseInt(govLength.trim());
                    } catch (NumberFormatException e) {
                        // Advisory only; absence changes nothing.
                    }
                }
            }
            camera.profiles.put(token, found);
        }
    }

    /** ONVIF spells these H264/H265/JPEG; ffmpeg and browsers use other names. */
    private static String normaliseCodec(String encoding) {
        if (encoding == null) {
            return null;
        }
        return switch (encoding.trim().toUpperCase()) {
            case "H264" -> "h264";
            case "H265", "HEVC" -> "hevc";
            case "JPEG", "MJPEG" -> "mjpeg";
            case "MPEG4" -> "mpeg4";
            default -> encoding.trim().toLowerCase();
        };
    }

    void fillStreamUri(DiscoveredCamera camera, String mediaUrl, String profileToken,
                       String username, String password) throws Exception {
        // Media2 dropped StreamSetup in favour of a bare Protocol element.
        String body = isMedia2(mediaUrl)
                ? """
                    <t:GetStreamUri>
                      <t:Protocol>RTSP</t:Protocol>
                      <t:ProfileToken>%s</t:ProfileToken>
                    </t:GetStreamUri>
                    """.formatted(escape(profileToken))
                : """
                    <t:GetStreamUri>
                      <t:StreamSetup>
                        <Stream xmlns="http://www.onvif.org/ver10/schema">RTP-Unicast</Stream>
                        <Transport xmlns="http://www.onvif.org/ver10/schema"><Protocol>RTSP</Protocol></Transport>
                      </t:StreamSetup>
                      <t:ProfileToken>%s</t:ProfileToken>
                    </t:GetStreamUri>
                    """.formatted(escape(profileToken));

        Document response = call(mediaUrl, isMedia2(mediaUrl) ? MEDIA2_NS : MEDIA_NS, body, username, password);

        String uri = Xml.text(response, "Uri");
        DiscoveredCamera.DiscoveredProfile profile = camera.profiles.get(profileToken);
        if (uri != null && profile != null) {
            profile.rtspUrl = uri.trim();
        }
    }

    private static String escape(String value) {
        return value == null ? "" : value
                .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                .replace("\"", "&quot;").replace("'", "&apos;");
    }
}
