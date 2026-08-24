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
    private static final String MEDIA_NS = "http://www.onvif.org/ver10/media/wsdl";

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

    /** Media service endpoint, which is frequently not the device endpoint. */
    String mediaServiceUrl(DiscoveredCamera camera, String username, String password) {
        try {
            Document response = call(camera.onvifServiceUrl, DEVICE_NS,
                    "<t:GetServices><t:IncludeCapability>false</t:IncludeCapability></t:GetServices>",
                    username, password);
            for (Element service : Xml.elements(response, "Service")) {
                String namespace = Xml.text(service, "Namespace");
                if (namespace != null && namespace.contains("media")) {
                    String address = Xml.text(service, "XAddr");
                    if (address != null && !address.isBlank()) {
                        return address;
                    }
                }
            }
        } catch (Exception e) {
            log.debug("GetServices failed for {}: {}", camera.ipAddress, e.toString());
        }
        // Older devices only implement the ver10 media service at a fixed path.
        return camera.onvifServiceUrl.replaceAll("/onvif/.*$", "/onvif/media_service");
    }

    void fillProfiles(DiscoveredCamera camera, String mediaUrl, String username, String password) throws Exception {
        Document response = call(mediaUrl, MEDIA_NS, "<t:GetProfiles/>", username, password);
        for (Element profile : Xml.elements(response, "Profiles")) {
            String token = profile.getAttribute("token");
            if (token == null || token.isBlank()) {
                continue;
            }
            DiscoveredCamera.DiscoveredProfile found = new DiscoveredCamera.DiscoveredProfile();
            found.token = token;
            found.name = Xml.text(profile, "Name");

            Element videoEncoder = Xml.firstElement(profile, "VideoEncoderConfiguration");
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
        Document response = call(mediaUrl, MEDIA_NS, """
            <t:GetStreamUri>
              <t:StreamSetup>
                <Stream xmlns="http://www.onvif.org/ver10/schema">RTP-Unicast</Stream>
                <Transport xmlns="http://www.onvif.org/ver10/schema"><Protocol>RTSP</Protocol></Transport>
              </t:StreamSetup>
              <t:ProfileToken>%s</t:ProfileToken>
            </t:GetStreamUri>
            """.formatted(escape(profileToken)), username, password);

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
