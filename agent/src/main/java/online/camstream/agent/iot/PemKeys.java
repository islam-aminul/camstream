package online.camstream.agent.iot;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;
import java.security.spec.PKCS8EncodedKeySpec;
import java.util.Base64;

/**
 * Builds an in-memory keystore from the PEM files fleet provisioning writes.
 *
 * JSSE needs a KeyStore, and no PKCS#12 file is kept on disk — converting on
 * each start avoids a second copy of the device key and a password to protect
 * it with.
 *
 * AWS IoT issues PKCS#1 keys (`BEGIN RSA PRIVATE KEY`) while Java's KeyFactory
 * accepts only PKCS#8, so a PKCS#1 body is wrapped in the PKCS#8 envelope here.
 * That is a fixed, well-defined DER prefix rather than a re-encoding, which is
 * why it does not need a full ASN.1 library.
 */
final class PemKeys {

    private PemKeys() {
    }

    static KeyStore keyStore(String certificatePem, String privateKeyPem, char[] password) throws Exception {
        CertificateFactory factory = CertificateFactory.getInstance("X.509");
        Certificate certificate = factory.generateCertificate(
                new ByteArrayInputStream(certificatePem.getBytes(StandardCharsets.UTF_8)));

        KeyStore store = KeyStore.getInstance("PKCS12");
        store.load(null, password);
        store.setKeyEntry("device", privateKey(privateKeyPem), password, new Certificate[] { certificate });
        return store;
    }

    static PrivateKey privateKey(String pem) throws Exception {
        String body = pem.replaceAll("-----(BEGIN|END)[^-]+-----", "").replaceAll("\\s", "");
        byte[] der = Base64.getDecoder().decode(body);
        if (pem.contains("BEGIN RSA PRIVATE KEY")) {
            der = pkcs1ToPkcs8(der);
        }
        return KeyFactory.getInstance("RSA").generatePrivate(new PKCS8EncodedKeySpec(der));
    }

    /**
     * PrivateKeyInfo ::= SEQUENCE {
     *   version           INTEGER (0),
     *   algorithm         AlgorithmIdentifier (rsaEncryption, NULL),
     *   privateKey        OCTET STRING (the PKCS#1 body, unchanged)
     * }
     */
    private static byte[] pkcs1ToPkcs8(byte[] pkcs1) throws Exception {
        // 1.2.840.113549.1.1.1 rsaEncryption, with the required NULL parameters.
        byte[] algorithm = { 0x30, 0x0d, 0x06, 0x09, 0x2a, (byte) 0x86, 0x48,
                (byte) 0x86, (byte) 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00 };
        byte[] version = { 0x02, 0x01, 0x00 };

        ByteArrayOutputStream octetString = new ByteArrayOutputStream();
        octetString.write(0x04);
        writeLength(octetString, pkcs1.length);
        octetString.write(pkcs1);

        ByteArrayOutputStream contents = new ByteArrayOutputStream();
        contents.write(version);
        contents.write(algorithm);
        contents.write(octetString.toByteArray());

        ByteArrayOutputStream sequence = new ByteArrayOutputStream();
        sequence.write(0x30);
        writeLength(sequence, contents.size());
        sequence.write(contents.toByteArray());
        return sequence.toByteArray();
    }

    /** DER length: short form below 128, otherwise a byte count then the value. */
    private static void writeLength(ByteArrayOutputStream out, int length) {
        if (length < 0x80) {
            out.write(length);
            return;
        }
        int bytes = 0;
        for (int value = length; value > 0; value >>>= 8) {
            bytes++;
        }
        out.write(0x80 | bytes);
        for (int i = bytes - 1; i >= 0; i--) {
            out.write((length >>> (i * 8)) & 0xff);
        }
    }
}
