import * as optl from '@opentelemetry/sdk-node'
import * as api from '@opentelemetry/api'
export { Attributes } from '@opentelemetry/api';
// import { ConsoleSpanExporter } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { SemanticAttributes, SemanticResourceAttributes } from '@opentelemetry/semantic-conventions'
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import { Resource } from '@opentelemetry/resources'
import { env } from 'vscode';
// import * as util from './util'
import * as vscode from 'vscode'

import { trace,
    Span, SpanStatusCode, SpanContext, Context, SpanOptions } from '@opentelemetry/api'
import { Disposable } from 'vscode-jsonrpc';
import { log } from 'console';

let traceExporter = new OTLPTraceExporter({ url: 'http://192.168.20.152:4318/v1/traces' });

export { SpanStatusCode } from '@opentelemetry/api';

export class MyTelemetry implements Disposable {
    private sdk : optl.NodeSDK;
    private tracer : optl.api.Tracer;
    private spans: Span[] = [];
    private disposables: Disposable[] = [];

    constructor(extensionContext: vscode.ExtensionContext) {

        let traceExporter = new OTLPTraceExporter({ url: 'http://192.168.20.152:4318/v1/traces' });

        this.sdk = new optl.NodeSDK({
            traceExporter,
            instrumentations: [],
            resourceDetectors: [],
            autoDetectResources: false,
            resource: new Resource({
                [SemanticResourceAttributes.SERVICE_NAME]: "ext",
                [SemanticResourceAttributes.DEVICE_ID]: env.machineId.slice(0, 8),
                [SemanticResourceAttributes.SERVICE_INSTANCE_ID]: env.sessionId,
                [SemanticResourceAttributes.HOST_NAME]: env.appHost,
                [SemanticResourceAttributes.SERVICE_NAMESPACE]: env.appName,
            })
        });
        const contextManager = new AsyncHooksContextManager();
        contextManager.enable();
        api.context.setGlobalContextManager(contextManager);

        if (env.isTelemetryEnabled) {
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
        this.startSpan("edit");
    }

    public async deactivate() {
        this.spans.forEach(s => s.end());
        return this.sdk.shutdown();
    }

    public logEvent(eventName: string, attributes?: api.Attributes, span?: Span) {
        if (!this.spans.length)
            this.startSpan('def');
        let s : Span = span || this.spans[this.spans.length - 1];
        s.addEvent(eventName, attributes);
    }
    public logException(exception: Error, span?: Span) {
        if (!this.spans.length)
            this.startSpan('def');
        let s : Span = span || this.spans[this.spans.length - 1];
        s.recordException({code: exception.name, message: exception.message, stack: exception.stack});
    }
    public startSpan(name: string, span? : Span) : void {
        let newspan : Span;
        if (this.spans.length) {
            const ctx = api.trace.setSpan(api.context.active(), this.spans[this.spans.length - 1]);
            newspan = this.tracer.startSpan(name, undefined, ctx);
        } else {
            newspan = this.tracer.startSpan(name);
        }
        this.spans.push(newspan);
    }
    public endSpan() {
        if (this.spans.length)
            this.spans.pop()?.end();
    }
    public endSpanWithStatus(status: SpanStatusCode, message?: string, attributes?: api.Attributes) {

        if (this.spans.length) {
            this.spans[this.spans.length - 1].setStatus({ code: status, message: message });
            if (attributes)
                this.spans[this.spans.length - 1].setAttributes(attributes);
            this.endSpan();
        }
    }
    public setAttributes(attributes: api.Attributes) {
        if (this.spans.length)
            this.spans[this.spans.length - 1].setAttributes(attributes);
    }
    public setSpanStatus(status: SpanStatusCode, message?: string) {
        if (this.spans.length)
            this.spans[this.spans.length - 1].setStatus({ code: status, message: message });
    }

    dispose() {
        this.disposables.forEach(d => d.dispose());
    }
}
