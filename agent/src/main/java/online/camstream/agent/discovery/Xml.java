package online.camstream.agent.discovery;

import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;

import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilderFactory;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Small DOM helper for ONVIF's SOAP responses.
 *
 * Cameras are untrusted input on the customer's network, so the parser is
 * locked down: no DTDs, no external entities, no schema resolution. An ONVIF
 * reply is never a legitimate reason to make the agent open a file or a socket.
 */
final class Xml {

    private Xml() {
    }

    static Document parse(byte[] xml) throws Exception {
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        factory.setFeature("http://xml.org/sax/features/external-general-entities", false);
        factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
        factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD, "");
        factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_SCHEMA, "");
        factory.setXIncludeAware(false);
        factory.setExpandEntityReferences(false);
        factory.setNamespaceAware(true);
        return factory.newDocumentBuilder().parse(new ByteArrayInputStream(xml));
    }

    /**
     * All elements with the given local name, ignoring namespace prefix.
     * ONVIF implementations are inconsistent about prefixes, so matching on
     * local name is more reliable than on a qualified name.
     */
    static List<Element> elements(Node root, String localName) {
        List<Element> found = new ArrayList<>();
        collect(root, localName, found);
        return found;
    }

    static Element firstElement(Node root, String localName) {
        List<Element> all = elements(root, localName);
        return all.isEmpty() ? null : all.get(0);
    }

    static String text(Node root, String localName) {
        Element element = firstElement(root, localName);
        return element == null ? null : element.getTextContent().trim();
    }

    static Integer integer(Node root, String localName) {
        String value = text(root, localName);
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            // Some cameras report framerate as "25.000".
            return (int) Double.parseDouble(value.trim());
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static void collect(Node node, String localName, List<Element> found) {
        NodeList children = node.getChildNodes();
        for (int i = 0; i < children.getLength(); i++) {
            Node child = children.item(i);
            if (child.getNodeType() != Node.ELEMENT_NODE) {
                continue;
            }
            Element element = (Element) child;
            String name = element.getLocalName() == null ? element.getNodeName() : element.getLocalName();
            int colon = name.indexOf(':');
            if (colon >= 0) {
                name = name.substring(colon + 1);
            }
            if (name.equals(localName)) {
                found.add(element);
            }
            collect(element, localName, found);
        }
    }

    static byte[] utf8(String s) {
        return s.getBytes(StandardCharsets.UTF_8);
    }
}
