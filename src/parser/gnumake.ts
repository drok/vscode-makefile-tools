// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// TODO: support also the scenario of parsing a build log,
// to overcome some of --dry-run limitations
// (like some exceptions to the 'do not execute' rule
// or dependencies on a real build)

import * as configuration from '../configuration';
import * as logger from '../logger';
import * as make from '../make';
import * as util from '../util';
import * as vscode from 'vscode';

const chunkSize: number = 100;

export async function parseTargets(cancel: vscode.CancellationToken, verboseLog: string,
                                   statusCallback: (message: string) => void,
                                   foundTargetCallback: (target: string) => void): Promise<number> {
    if (cancel.isCancellationRequested) {
        return make.ConfigureBuildReturnCodeTypes.cancelled;
    }

    // Extract the text between "# Files" and "# Finished Make data base" lines
    // There can be more than one matching section.
    let regexpExtract: RegExp = /(# Files\n*)([\s\S]*?)(\n# Finished Make data base)/mg;
    let result: RegExpExecArray | null;
    let extractedLog: string = "";

    let matches: string[] = [];
    let match: string[] | null;
    result = await util.scheduleTask(() => regexpExtract.exec(verboseLog));

    while (result) {
        extractedLog = result[2];

        // Skip lines starting with {#,.} or preceeded by "# Not a target" and extract the target.
        // Additionally, if makefile.phonyOnlyTargets is true, include only targets
        // succeeded by "#  Phony target (prerequisite of .PHONY).".
        let regexpTargetStr: string = "^(?!\\n?[#\\.])(?<!^\\n?# Not a target:\\s*)\\s*(\\S*[^:]):\\s+";
        if (configuration.getPhonyOnlyTargets()) {
         regexpTargetStr += ".*\\s+(?=#  Phony target \\(prerequisite of \\.PHONY\\)\\.)";
        }
        let regexpTarget: RegExp = RegExp(regexpTargetStr, "mg");

        match = regexpTarget.exec(extractedLog);

        if (match) {
            let done: boolean = false;
            let doParsingChunk: (() => void) = () => {
                let chunkIndex: number = 0;

                while (match && chunkIndex <= chunkSize) {
                    // Make sure we don't insert duplicates.
                    // They can be caused by the makefile syntax of defining variables for a target.
                    // That creates multiple lines with the same target name followed by :,
                    // which is the pattern parsed here.
                    if (!matches.includes(match[1])) {
                        matches.push(match[1]);
                        foundTargetCallback(match[1]);
                    }

                    statusCallback("Parsing build targets...");
                    match = regexpTarget.exec(extractedLog);

                    if (!match) {
                        done = true;
                    }

                    chunkIndex++;
                }
            };
            while (!done) {
                if (cancel.isCancellationRequested) {
                    return make.ConfigureBuildReturnCodeTypes.cancelled;
                }

                await util.scheduleTask(doParsingChunk);
            }
        } // if match

        result = await util.scheduleTask(() => regexpExtract.exec(verboseLog));
    } // while result

    return cancel.isCancellationRequested ? make.ConfigureBuildReturnCodeTypes.cancelled : make.ConfigureBuildReturnCodeTypes.success;
}
