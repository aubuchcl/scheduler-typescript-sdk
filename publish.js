#!/usr/bin/env node
/**
 * Publish a message onto the Cycle scheduler message bus.
 *
 *   node publish.mjs --topic orders.created --payload '{"id":"1234"}'
 *   echo '{"id":"1234"}' | node publish.mjs --topic orders.created --ttl 60
 *
 * Options (each falls back to the matching environment variable):
 *   --topic       TOPIC        required. Alphanumerics, dots, hyphens, underscores.
 *   --payload     PAYLOAD      JSON. Read from stdin when piped and not passed.
 *   --ttl         TTL          seconds the bus retains the message for consumers
 *                              that are not currently connected. Omitted = no
 *                              retention, so only live consumers see it.
 *   --channel     CHANNEL      publish over a named channel instead of the default.
 *   --annotation  k=v          repeatable. String key/value pairs on the message.
 *   --raw                      send the payload as a JSON string rather than
 *                              parsing it.
 *
 * Environment:
 *   ACCESS_TOKEN  required
 *   BASE_URL      defaults to http://env-scheduler
 */
import { getClient } from "@cycleplatform/scheduler-api-client";

function parseArgs(argv) {
    const opts = { annotations: {} };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];

        if (arg === "--raw") {
            opts.raw = true;
            continue;
        }

        if (arg === "--annotation") {
            const pair = argv[++i] ?? "";
            const eq = pair.indexOf("=");

            if (eq < 1) {
                throw new Error(`--annotation expects k=v, got "${pair}"`);
            }

            opts.annotations[pair.slice(0, eq)] = pair.slice(eq + 1);
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

async function readStdin() {
    if (process.stdin.isTTY) {
        return undefined;
    }

    const chunks = [];

    for await (const chunk of process.stdin) {
        chunks.push(chunk);
    }

    const text = Buffer.concat(chunks).toString("utf8").trim();

    if (text === "") {
        return undefined;
    }

    return text;
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));

    const accessToken = process.env.ACCESS_TOKEN;

    if (!accessToken) {
        throw new Error("ACCESS_TOKEN is not set");
    }

    const topic = opts.topic ?? process.env.TOPIC;

    if (!topic) {
        throw new Error("no topic - pass --topic or set TOPIC");
    }

    const rawPayload = opts.payload ?? process.env.PAYLOAD ?? (await readStdin());

    if (rawPayload === undefined) {
        throw new Error(
            "no payload - pass --payload, set PAYLOAD, or pipe JSON on stdin",
        );
    }

    let payload;

    if (opts.raw) {
        payload = rawPayload;
    } else {
        try {
            payload = JSON.parse(rawPayload);
        } catch (cause) {
            throw new Error(
                `payload is not valid JSON (use --raw to send it as a string): ${cause.message}`,
            );
        }
    }

    const client = getClient({
        accessToken,
        baseUrl: process.env.BASE_URL || "http://env-scheduler",
    });

    const body = { message: { topic, payload } };

    if (Object.keys(opts.annotations).length > 0) {
        body.message.annotations = opts.annotations;
    }

    const ttl = opts.ttl ?? process.env.TTL;

    if (ttl !== undefined) {
        const seconds = Number(ttl);

        if (!Number.isFinite(seconds) || seconds < 0) {
            throw new Error(`ttl must be a non-negative number, got "${ttl}"`);
        }

        body.durability = { ttl: seconds };
    }

    // A consumer only sees this if it subscribed to the same channel. The
    // default channel is used when neither side sets one.
    const channel = opts.channel ?? process.env.CHANNEL;

    if (channel !== undefined) {
        body.distribution = { channel };
    }

    const resp = await client.POST("/v1/message/bus", { body });

    if (resp.error) {
        const err = resp.error.error ?? resp.error;

        console.error(
            `publish failed: ${err.status ?? ""} ${err.code ?? ""} ${
                err.title ?? err.detail ?? JSON.stringify(resp.error)
            }`.trim(),
        );

        process.exitCode = 1;
        return;
    }

    const { message, sent } = resp.data.data;

    console.log(
        JSON.stringify({
            uuid: message.uuid,
            topic: message.topic,
            time: message.time,
            sent,
        }),
    );
}

main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
});
