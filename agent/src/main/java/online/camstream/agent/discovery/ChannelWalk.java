package online.camstream.agent.discovery;

/**
 * How far to walk a recorder's channels, and when to stop.
 *
 * A recorder is many cameras behind one address, and nothing it serves says
 * how many. The only way to find out is to ask for channel 1, then 2, and keep
 * going until the answers stop — which is fine except that "keep going" against
 * a device that has four channels and a ceiling of sixty-four is sixty wasted
 * probes, each one a timeout.
 *
 * So the walk stops after a run of consecutive failures rather than at the
 * ceiling. Consecutive is the important word: recorders routinely have gaps,
 * because a channel with no camera plugged into it answers nothing while the
 * channels after it are live. Stopping at the first gap finds four cameras on a
 * sixteen-channel recorder with one empty bay.
 *
 * Kept separate from the probing so the arithmetic can be tested without a
 * recorder, which is the part that is easy to get subtly wrong.
 */
public final class ChannelWalk {

    /**
     * How many channels to consider at most.
     *
     * Recorders above this exist but are rare, and the cost of the ceiling is
     * paid only by sites that genuinely have one.
     */
    public static final int MAX_CHANNELS = 64;

    /**
     * How many empty channels in a row end the walk.
     *
     * Three covers the ordinary case of an unused bay or two between cameras
     * without walking a whole empty recorder.
     */
    public static final int STOP_AFTER_EMPTY = 3;

    private final int maxChannels;
    private final int stopAfterEmpty;

    private int channel;
    private int consecutiveEmpty;
    private int found;

    public ChannelWalk() {
        this(MAX_CHANNELS, STOP_AFTER_EMPTY);
    }

    ChannelWalk(int maxChannels, int stopAfterEmpty) {
        this.maxChannels = maxChannels;
        this.stopAfterEmpty = stopAfterEmpty;
    }

    /** Whether there is another channel worth asking about. */
    public boolean hasNext() {
        return channel < maxChannels && consecutiveEmpty < stopAfterEmpty;
    }

    /** The next channel number to try. */
    public int next() {
        return ++channel;
    }

    /** Records that a channel answered with a stream. */
    public void found() {
        consecutiveEmpty = 0;
        found++;
    }

    /** Records that a channel had nothing on it. */
    public void empty() {
        consecutiveEmpty++;
    }

    public int channelsFound() {
        return found;
    }

    /** The channel last asked about, for logging a walk that stopped early. */
    public int lastChannel() {
        return channel;
    }
}
