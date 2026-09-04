/**
 * Custom metrics, written to the log rather than sent.
 *
 * CloudWatch's embedded metric format: a specially shaped JSON line on stdout
 * is picked up by the log agent and turned into a metric. That matters here
 * because the alternative — a PutMetricData call — is a network round trip on
 * a request path, needs IAM, and fails in its own right. A log line cannot slow
 * a request down or fail it, which is the correct trade for telemetry.
 *
 * Deliberately few metrics. Every one of these exists because there is an alarm
 * that needs it and a question it answers; a metric nobody alarms on is a bill
 * and a distraction.
 */
const NAMESPACE = 'CamStream';

type Unit = 'Count' | 'Seconds' | 'Milliseconds';

/**
 * Emits one metric value.
 *
 * No dimensions, on purpose. A dimension per tenant or per agent multiplies the
 * custom-metric bill by the size of the estate and gives alarms that have to be
 * created per dimension value — which nothing here does. These are fleet-wide
 * questions: is anything heartbeating, is anyone being refused.
 */
export function emit(name: string, value: number, unit: Unit = 'Count'): void {
  // Guarded so a telemetry mistake can never take down the request it is
  // measuring. There is nothing here worth failing a stream over.
  try {
    console.log(JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [{
          Namespace: NAMESPACE,
          Dimensions: [[]],
          Metrics: [{ Name: name, Unit: unit }],
        }],
      },
      [name]: value,
    }));
  } catch {
    // Ignored by design.
  }
}

export const METRICS = {
  /**
   * Renditions a site was asked for and refused, because converting them would
   * exceed what that agent may run at once. A viewer sees "the site is at
   * capacity" and nothing plays, so a sustained non-zero count is somebody
   * looking at a black tile that will not recover on its own.
   */
  TRANSCODES_DECLINED: 'TranscodesDeclined',
} as const;
