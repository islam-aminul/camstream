package online.camstream.agent.config;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Reading the text files an operator hands the agent.
 *
 * These arrive from Windows more often than not, and Windows writes UTF-8 with
 * a byte-order mark by default — PowerShell 5.1's `Set-Content -Encoding UTF8`
 * does, Notepad does, and several editors do it silently on save. A BOM is
 * three bytes of U+FEFF at the front, and neither a JSON nor a YAML parser
 * will accept it: both fail on the first character with a message naming a
 * code point nobody typed.
 *
 * The agent used to crash-loop on exactly this. The file was correct, the
 * error was unreadable, and the fix belonged in the one place every such file
 * is read rather than in every tool that might have written it.
 */
public final class TextFiles {

    /** U+FEFF, which UTF-8 encodes as EF BB BF and Java decodes to one char. */
    private static final char BOM = '﻿';

    private TextFiles() {
    }

    /**
     * Reads a UTF-8 text file, tolerating a leading byte-order mark.
     *
     * Only a leading one is stripped. A U+FEFF anywhere else is a zero-width
     * no-break space that somebody meant to be there, and removing it silently
     * would corrupt the value it sits in.
     */
    public static String read(Path path) throws IOException {
        return stripBom(Files.readString(path));
    }

    public static String stripBom(String text) {
        return !text.isEmpty() && text.charAt(0) == BOM ? text.substring(1) : text;
    }
}
