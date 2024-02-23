import * as dns from 'dns'
import * as optl from '@opentelemetry/sdk-node'
import * as api from '@opentelemetry/api'
export { Attributes } from '@opentelemetry/api';
// import { ConsoleSpanExporter } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions'
import { SpanProcessor, TraceIdRatioBasedSampler, ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import { Resource } from '@opentelemetry/resources'
import { TraceState } from '@opentelemetry/api'
import { env } from 'vscode';
import { getSettingOr } from './util';
import { Extension, openSettings } from './extension';
// import * as util from './util'
import * as vscode from 'vscode'
import { buildinfo } from '../buildinfo';

import { trace,
    Span, SpanStatusCode, SpanContext, Context, SpanOptions } from '@opentelemetry/api'
import { Disposable } from 'vscode-jsonrpc';

export { SpanStatusCode } from '@opentelemetry/api';

export class MyTelemetry implements Disposable {
    private sdk : optl.NodeSDK;
    private tracer : optl.api.Tracer;
    private disposables: Disposable[] = [];

    constructor(extensionContext: vscode.ExtensionContext, params: Params) {
        let traceExporter = new OTLPTraceExporter({
                // url: 'http://192.168.20.152:4318/v1/traces',
                url: 'https://log.mergesium.com/v1/traces',
             });

        this.sdk = new optl.NodeSDK({
            traceExporter,

            spanProcessor: new TailSamplingProcessor(
                    new optl.node.TraceIdRatioBasedSampler(params.s),
                    new optl.node.TraceIdRatioBasedSampler(params.e),
                    new optl.node.TraceIdRatioBasedSampler(params.u),
                    traceExporter),
            instrumentations: [],
            resourceDetectors: [],
            autoDetectResources: false,
            resource: new Resource({
                [SemanticResourceAttributes.SERVICE_NAME]: extensionContext.extension.packageJSON.name,
                [SemanticResourceAttributes.SERVICE_VERSION]: extensionContext.extension.packageJSON.version,
                ['buildinfo']: `${buildinfo.platform}-${buildinfo.arch}`,
                [SemanticResourceAttributes.SERVICE_NAMESPACE]:
                    (env.appName == "Visual Studio Code" ? "vscode" : env.appName) + "." + env.appHost + '-' + vscode.version,
                [SemanticResourceAttributes.OS_TYPE]: process.platform,
                [SemanticResourceAttributes.HOST_ARCH]: process.arch,
                [SemanticResourceAttributes.PROCESS_RUNTIME_VERSION]: process.version,
                [SemanticResourceAttributes.SERVICE_INSTANCE_ID]: env.sessionId,
                [SemanticResourceAttributes.DEVICE_ID]: env.machineId.slice(0, 8),
                ['lang']: env.language,
            })
        });
        const contextManager = new AsyncHooksContextManager();
        contextManager.enable();
        api.context.setGlobalContextManager(contextManager);

        if (env.isTelemetryEnabled && getSettingOr<boolean>(null, "telemetry", true)) {
            this.sdk.start();
        }
        this.disposables.push(env.onDidChangeTelemetryEnabled((e) => {
            if (e)
                this.sdk.start();
            else
                this.sdk.shutdown();
          }));

          process.on('SIGTERM', () => {
            this.sdk.shutdown()
            .then(() => console.log('Tracing terminated'))
            .catch((error) => console.log('Error terminating tracing', error))
            .finally(() => process.exit(0));
          });
        this.tracer = trace.getTracer(
            extensionContext.extension.packageJSON.name,
            extensionContext.extension.packageJSON.version);
        // this.startSpan("edit");
        // this.setSpanStatus(optl.api.SpanStatusCode.OK);
        // this.setAttributes({
        //     "a": 1,
        //     "b": false
        // });
        // this.endSpan();
    }

    public async deactivate() {
        // this.spans.forEach(s => s.end());
        return this.sdk.shutdown();
    }

    public logEvent(span: Span, eventName: string, attributes?: api.Attributes, unusual?: boolean) {
        if (unusual) {
            let traceState = span.spanContext().traceState;
            if (!traceState) {
                traceState = new Wanted("unusual");
                span.spanContext().traceState = traceState;
            }
            traceState?.set("unusual", "true");
        }
        span.addEvent(eventName, attributes);
    }
    public logException(exception: Error, span: Span) {
        if (exception instanceof Error)
            span.setStatus({code: SpanStatusCode.ERROR, message: 'ex'});
        span.recordException({code: exception.name, message: exception.message, stack: exception.stack});
    }
    public startSpan(name: string, span? : Span) : Span {
        let newspan : Span;
        const ctx = span ? api.trace.setSpan(api.context.active(), span) : undefined;
        newspan = this.tracer.startSpan(name, undefined, ctx);
        return newspan;
    }
    public endSpanWithStatus(span: Span, status: SpanStatusCode, message?: string, attributes?: api.Attributes) {

        span.setStatus({ code: status, message: message });
        if (attributes)
            span.setAttributes(attributes);
        span.end();
    }
    public setAttributes(span: Span, attributes: api.Attributes) {
        span.setAttributes(attributes);
    }
    public setSpanStatus(span: Span, status: SpanStatusCode, message?: string) {
        span.setStatus({ code: status, message: message });
        if (status == SpanStatusCode.ERROR) {
            if (!span.spanContext().traceState) {
                span.spanContext().traceState = new Wanted("unusual");
            }
            span.spanContext().traceState?.set("unusual", "true");
        }
    }

    dispose() {
        this.disposables.forEach(d => d.dispose());
    }
}

class Wanted implements TraceState {
    constructor(private myKey: string) {
        this.myVal = "";
    }
    get(key: string): string | undefined {
        return this.myKey == key ? this.myVal : "";
    }
    set(key: string, value: string): optl.api.TraceState {
        if (key == this.myKey) this.myVal = value;
        return this;
    }
    unset(key: string): optl.api.TraceState {
        this.myVal = "";
        return this;
    }
    public serialize(): string {
        return this.myKey;
    }
    private myVal: string;
}

class TailSamplingProcessor implements SpanProcessor {

  constructor(private readonly sampler: TraceIdRatioBasedSampler,
        private readonly errorSampler: TraceIdRatioBasedSampler,
        private readonly unusualSampler: TraceIdRatioBasedSampler,
        private delegate: OTLPTraceExporter) {
    this.sampler = sampler;
  }

  onStart(span: Span, context: Context): void {
  }

  // Implement other required methods of SpanProcessor
  onEnd(span: ReadableSpan): void {
    // Trigger exporting when the span starts
    let traceState = span.spanContext().traceState;
    if ((span.status.code == SpanStatusCode.ERROR && this.errorSampler.shouldSample(span.spanContext(), span.spanContext().traceId).decision == api.SamplingDecision.RECORD_AND_SAMPLED)||
        (traceState instanceof Wanted && traceState.get("unusual") && this.unusualSampler.shouldSample(span.spanContext(), span.spanContext().traceId).decision == api.SamplingDecision.RECORD_AND_SAMPLED) ||
        this.sampler.shouldSample(span.spanContext(), span.spanContext().traceId).decision == api.SamplingDecision.RECORD_AND_SAMPLED) {
            this.delegate.send([span], () => {
                // Success callback
                 // console.log('Export successful');
                }, (error: any) => {
                // Error callback
                // console.error('Export error:', error);
                
            });
    }
  }

  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }
  forceFlush(): Promise<void> {
    return this.delegate.forceFlush();
  }
}

/**
 *
 * @abstract Params Telemetry Sampling parameters
 * @member s - Sampling rate for non-error, non-unusual traces
 * @member e - Sampling rate for error traces
 * @member u - Sampling rate for unusual traces
 */
export interface Params {
    s: number;
    u: number;
    e: number;
    /*
     * pre_ok = ok to run if pre-rel
     * pre_update = request user update
     */
    pre_ok?: number;
    pre_update?: number;
}

export function getStartTime(span: Span) : Date {
    let d : [ number, number ] = (span as any).startTime; //_getTime();//  spanContext();
    return span ? new Date(d[0]*1000 + (d[1]/1000000)) : new Date(); // in case tele is disabled?
}

/* Example - conf[] where each conf = Params as array.
[[0,.9,.9,.9],[1,1,.4,3,1,1,0]]
[
  [
    0,    // 0 - applies to all versions
    0.9,  // sample = 90%
    0.9,  // unusual = 90%
    0.9   // errors = 90%
          // implies = no pre release allowed
  ],
  [
    1,    // applies to myVersion == 1
    1,    // sample 100%
    0.4,  // unusual = 40%
    0.9,  // errors = 90%
    1,    // pre-release = ok to run
    1     // pre-release = request to update
  ]
]


 */
export async function getParams() : Promise<Params> {
    // let r : Params | undefined;
    if (env.isTelemetryEnabled) {
        let z = await new Promise<Params>(resolve => {
            dns.resolveTxt("log.autotools.mergesium.com", (err, text : string[][]) => {
            if (!err) {
                let param: Params = {s: 0.1, u: 0.4, e: 1}; // defaults
                for (const t of text) {
                    for (const tt of t) {
                        try {
                            let r = JSON.parse(tt);
                            if (Array.isArray(r) && !r.some(i => !Array.isArray(i) || i.some(iv => isNaN(Number(iv))))) {
                                for (const conf of r) {
                                    if (conf[0] == 0 || conf[0] >= Extension.myVersion) {
                                        if (conf.length >= 4)
                                            param = {s:conf[1], u:conf[2], e:conf[3], pre_ok: 0};
                                        if (conf.length >= 5)
                                            param.pre_ok = conf[4];
                                        if (conf.length >= 6)
                                            param.pre_update = conf[5];
                                    }
                                    if (conf[0] >= Extension.myVersion) break;
                                }
                            }
                        } catch (e) {
                            console.debug("err", e);
                        }
                    }
                }
                resolve(param); /* If I botch the JSON string in TXT */
            } else {
                switch (err.code) {
                    case "ENOTFOUND": /* If I forget to set the defaults in DNS */
                        resolve({s: 0.1, u: 0.5, e: 1});
                        break;
                    default: /* Reasonable defaults in case of resolver errors */
                        resolve({s: 0.1, u: 0.4, e: 1}); // unknown pre-release, retry if running on a pre-rel
                        break;
                }
            }
        })});
        return z;
    }
    return {
        /* Defaults, when telemetry is disabled at start, skip the DNS lookuup
         * If enabled later, it's probably because something is not working,
         * and user wants it reported.
         */
        s: 1, u: 1, e: 1
    };
}
