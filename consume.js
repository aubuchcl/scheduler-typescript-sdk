#!/usr/bin/env node
/**
 * Consume messages from the Cycle scheduler message bus.
 *
 *   node consume.mjs
 *   node consume.mjs --topics orders.created,orders.shipped --channel jobs
 *
 * Prints one JSON object per line, so container logs stay machine readable.
 * Stays subscribed across scheduler restarts, reconnecting with jittered
 * exponential backoff, and shuts down cleanly on SIGTERM/SIGINT.
 *
 * Options (each falls back to the matching environment variable):
 *   --topics    TOPICS   comma separated. Omitted = every topic.
 *   --channel   CHANNEL  named channel. Omitted = the default channel.
 *                        Publishers must target the same channel.
 *   --max       MAX      exit after this many messages. Omitted = run forever.
 *   --pretty             indent the output instead of one line per message.
 *
 * Environment:
 *   ACCESS_TOKEN  required
 *   BASE_URL      defaults to http://env-scheduler
 */
import {
    getClient,
    MessageStreamError,
} from "@cycleplatform/scheduler-api-client";

const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 30_000;

function parseArgs(argv) {
    const opts = {};

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];

        if (arg === "--pretty") {
            opts.pretty = true;
            continue;
        }

        if (arg.startsWith("--")) {
            opts[arg.slice(2)] = argv[++i];
            continue;
        }

        throw new Error(`unexpected argument "${arg}"`);
    }

    return opts;
}

function sleep(ms, signal) {
    return new Promise((resolve) => {
        const done = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
        };

        const timer = setTimeout(done, ms);
        signal.addEventListener("abort", done, { once: true });
    });
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));

    const accessToken = process.env.ACCESS_TOKEN;

    if (!accessToken) {
        throw new Error("ACCESS_TOKEN is not set");
    }

    const rawTopics = opts.topics ?? process.env.TOPICS;
    const topics = rawTopics
        ? rawTopics
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean)
        : undefined;

    const channel = opts.channel ?? process.env.CHANNEL;

    const rawMax = opts.max ?? process.env.MAX;
    const max = rawMax === undefined ? Infinity : Number(rawMax);

    if (!Number.isFinite(max) && rawMax !== undefined) {
        throw new Error(`max must be a number, got "${rawMax}"`);
    }

    const client = getClient({
        accessToken,
        baseUrl: process.env.BASE_URL || "http://env-scheduler",
    });

    // node is PID 1 in the container, so these are the signals docker stop and
    // a Cycle redeploy actually send. Aborting ends the stream, which ends the
    // for-await below, which ends the reconnect loop.
    const shutdown = new AbortController();

    for (const signal of ["SIGTERM", "SIGINT"]) {
        process.on(signal, () => {
            if (shutdown.signal.aborted) {
                return;
            }

            console.error(`[consume] ${signal} - shutting down`);
            shutdown.abort();
        });
    }

    let received = 0;
    let attempt = 0;

    while (!shutdown.signal.aborted && received < max) {
        try {
            const stream = client.streamMessages({
                channel,
                topics,
                signal: shutdown.signal,
            });

            // The stream has no "open" event, so this is the attempt, not a
            // confirmed subscription - a failure surfaces on the first read.
            console.error(
                `[consume] connecting channel=${channel ?? "default"} topics=${
                    topics?.join(",") ?? "all"
                }`,
            );

            for await (const message of stream) {
                // Only reset once a message actually lands. A stream that opens
                // and immediately closes keeps backing off instead of spinning.
                attempt = 0;
                received++;

                console.log(
                    JSON.stringify(message, null, opts.pretty ? 2 : undefined),
                );

                if (received >= max) {
                    stream.close();
                    break;
                }
            }
        } catch (err) {
            // A rejected access key will not fix itself.
            if (
                err instanceof MessageStreamError &&
                (err.status === 401 || err.status === 403)
            ) {
                throw err;
            }

            console.error(`[consume] stream failed: ${err.message}`);
        }

        if (shutdown.signal.aborted || received >= max) {
            break;
        }

        const backoff = Math.min(RETRY_BASE_MS * 2 ** attempt++, RETRY_MAX_MS);

        // Jitter keeps a fleet of consumers from reconnecting in lockstep after
        // a scheduler restart.
        const delay = Math.round(backoff * (0.5 + Math.random() / 2));

        console.error(`[consume] reconnecting in ${delay}ms`);
        await sleep(delay, shutdown.signal);
    }

    console.error(`[consume] stopped after ${received} message(s)`);
}

main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
});
