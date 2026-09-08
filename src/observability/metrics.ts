import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Metrics, in Prometheus text format.
 *
 * Written by hand rather than pulled from a client library. The exposition
 * format is a few lines of text, kori exports a handful of series, and a
 * dependency that has to be kept current for the rest of the project's life is
 * a poor trade for that. If the metric set grew past this, prom-client would
 * be the right answer.
 *
 * Latency is a histogram rather than an average, because an average hides
 * exactly what matters. A mean of 40ms is consistent with every request taking
 * 40ms and with 99% taking 5ms while 1% take 4 seconds, and only the second is
 * an incident.
 */

const BUCKETS_MS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

interface RouteStats {
  count: number;
  sumMs: number;
  buckets: number[];
}

const requestsByStatus = new Map<string, number>();
const latencyByRoute = new Map<string, RouteStats>();
const counters = new Map<string, number>();

export function incrementCounter(name: string, by = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

export function observeRequest(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const started = process.hrtime.bigint();

    res.on("finish", () => {
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

      // Label by the route pattern, not the path. Using the raw path would
      // create a distinct time series per account id, which is the classic way
      // to bring down a metrics backend.
      const route = req.route?.path
        ? `${req.baseUrl}${req.route.path}`
        : normalisePath(req.path);

      const statusKey = `${req.method}|${route}|${res.statusCode}`;
      requestsByStatus.set(statusKey, (requestsByStatus.get(statusKey) ?? 0) + 1);

      const key = `${req.method}|${route}`;
      let stats = latencyByRoute.get(key);
      if (!stats) {
        stats = { count: 0, sumMs: 0, buckets: new Array(BUCKETS_MS.length).fill(0) };
        latencyByRoute.set(key, stats);
      }
      stats.count += 1;
      stats.sumMs += elapsedMs;
      for (let i = 0; i < BUCKETS_MS.length; i++) {
        if (elapsedMs <= BUCKETS_MS[i]!) stats.buckets[i]! += 1;
      }
    });

    next();
  };
}

/** Collapse identifiers out of a path so the label set stays bounded. */
function normalisePath(path: string): string {
  return path
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "/:id")
    .replace(/\/\d+/g, "/:n");
}

// Prometheus label values escape backslash, double quote and newline. Getting
// this wrong does not throw -- it produces a metrics page the scraper silently
// rejects, so the series simply stop appearing.
function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

export function renderMetrics(): string {
  const lines: string[] = [];

  lines.push("# HELP kori_http_requests_total Total HTTP requests by method, route and status.");
  lines.push("# TYPE kori_http_requests_total counter");
  for (const [key, count] of requestsByStatus) {
    const [method, route, status] = key.split("|") as [string, string, string];
    lines.push(
      `kori_http_requests_total{method="${escapeLabel(method)}",route="${escapeLabel(route)}",status="${status}"} ${count}`,
    );
  }

  lines.push("# HELP kori_http_request_duration_ms Request latency in milliseconds.");
  lines.push("# TYPE kori_http_request_duration_ms histogram");
  for (const [key, stats] of latencyByRoute) {
    const [method, route] = key.split("|") as [string, string];
    const labels = `method="${escapeLabel(method)}",route="${escapeLabel(route)}"`;
    for (let i = 0; i < BUCKETS_MS.length; i++) {
      lines.push(
        `kori_http_request_duration_ms_bucket{${labels},le="${BUCKETS_MS[i]}"} ${stats.buckets[i]}`,
      );
    }
    lines.push(`kori_http_request_duration_ms_bucket{${labels},le="+Inf"} ${stats.count}`);
    lines.push(`kori_http_request_duration_ms_sum{${labels}} ${stats.sumMs.toFixed(3)}`);
    lines.push(`kori_http_request_duration_ms_count{${labels}} ${stats.count}`);
  }

  for (const [name, value] of counters) {
    lines.push(`# TYPE kori_${name} counter`);
    lines.push(`kori_${name} ${value}`);
  }

  lines.push("# HELP kori_process_uptime_seconds Seconds since the process started.");
  lines.push("# TYPE kori_process_uptime_seconds gauge");
  lines.push(`kori_process_uptime_seconds ${process.uptime().toFixed(3)}`);

  const memory = process.memoryUsage();
  lines.push("# TYPE kori_process_heap_bytes gauge");
  lines.push(`kori_process_heap_bytes ${memory.heapUsed}`);

  return lines.join("\n") + "\n";
}

export function metricsHandler(): RequestHandler {
  return (_req, res) => {
    res.setHeader("content-type", "text/plain; version=0.0.4; charset=utf-8");
    res.send(renderMetrics());
  };
}

/** Test helper: forget everything collected so far. */
export function resetMetrics(): void {
  requestsByStatus.clear();
  latencyByRoute.clear();
  counters.clear();
}
