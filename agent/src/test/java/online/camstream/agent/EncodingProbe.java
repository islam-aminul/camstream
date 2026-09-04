package online.camstream.agent;

import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;

/**
 * Reports what encoding the agent's log streams end up with, from a JVM whose
 * native encoding has been forced to something other than UTF-8.
 *
 * It exists because the question cannot be answered in-process: Surefire
 * replaces {@code System.err} with a stream of its own before any test runs, so
 * a test that inspects the current process is measuring the harness. The first
 * version of this check did exactly that and passed with the fix deleted.
 *
 * Run by {@link LogFormatTest}, never on its own.
 */
public final class EncodingProbe {

    private EncodingProbe() {
    }

    public static void main(String[] args) throws Exception {
        // Answer on a stream this class controls, so the result cannot be
        // rewritten by whatever Main installs.
        PrintStream answer = new PrintStream(new FileOutputStream(FileDescriptor.out), true, StandardCharsets.UTF_8);

        // Initialising Main is the whole point: its static block is what should
        // install UTF-8 streams, and it must do so before the logger it also
        // declares is created.
        Class.forName(Main.class.getName());

        answer.println(((PrintStream) System.out).charset().name()
                + " " + ((PrintStream) System.err).charset().name());
    }
}
