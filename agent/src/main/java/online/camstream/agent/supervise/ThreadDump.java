package online.camstream.agent.supervise;

import java.lang.management.ManagementFactory;
import java.lang.management.ThreadInfo;
import java.lang.management.ThreadMXBean;

/**
 * The agent's own stack traces, taken from inside the agent.
 *
 * Deliberately in-process. The obvious way to answer "what is this JVM doing"
 * is jcmd or jstack from outside, and on this fleet that does not work: the
 * Windows service runs as a virtual account no ordinary user may attach to,
 * the Linux unit runs under a hardened systemd sandbox, and the bundled
 * runtime is a JRE with no attach tooling in it at all. Attaching with a
 * mismatched JDK is worse than useless — it killed the agent on 2026-09-06,
 * which ended the incident that was being investigated and destroyed the
 * evidence with it.
 *
 * {@link Thread#getAllStackTraces} needs no attach, no permission and no
 * matching toolchain. It is available to every JVM about itself, always.
 */
final class ThreadDump {

    /** Frames per thread. Enough to see where something is blocked, not a novel. */
    private static final int MAX_FRAMES = 24;

    private ThreadDump() {
    }

    /**
     * Every thread, what it is doing, and what it is waiting for.
     *
     * Monitor ownership is the part worth having. The suspected cause of the
     * incident this was written for is several tasks serialised behind one
     * {@code synchronized} credentials fetch, and that is invisible in a plain
     * list of stack traces but obvious the moment locks are named.
     */
    static String take() {
        ThreadMXBean threads = ManagementFactory.getThreadMXBean();
        ThreadInfo[] infos;
        try {
            // Monitor and synchronizer detail where the JVM will give it, which
            // is what names the lock somebody is queued on.
            infos = threads.dumpAllThreads(
                    threads.isObjectMonitorUsageSupported(),
                    threads.isSynchronizerUsageSupported());
        } catch (RuntimeException e) {
            return "could not take a thread dump: " + e;
        }

        StringBuilder out = new StringBuilder(4096);
        out.append(infos.length).append(" thread(s)");
        long[] deadlocked = threads.findDeadlockedThreads();
        if (deadlocked != null && deadlocked.length > 0) {
            // Worth saying first and separately: a deadlock is a different
            // diagnosis from a slow call, and the fix is not the same.
            out.append(" — DEADLOCK involving ").append(deadlocked.length).append(" of them");
        }
        out.append('\n');

        for (ThreadInfo info : infos) {
            if (info == null) {
                continue;
            }
            out.append('"').append(info.getThreadName()).append("\" ").append(info.getThreadState());
            if (info.getLockName() != null) {
                out.append(" on ").append(info.getLockName());
            }
            if (info.getLockOwnerName() != null) {
                // The whole point when tasks are queued behind one another.
                out.append(" held by \"").append(info.getLockOwnerName()).append('"');
            }
            out.append('\n');
            StackTraceElement[] stack = info.getStackTrace();
            for (int i = 0; i < stack.length && i < MAX_FRAMES; i++) {
                out.append("    at ").append(stack[i]).append('\n');
            }
            if (stack.length > MAX_FRAMES) {
                out.append("    ... ").append(stack.length - MAX_FRAMES).append(" more\n");
            }
        }
        return out.toString();
    }
}
