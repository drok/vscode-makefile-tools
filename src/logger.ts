// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// Logging support

import * as fs from 'fs';
import * as configuration from './configuration';
import * as vscode from 'vscode';

let makeOutputChannel: vscode.OutputChannel | undefined;

function getOutputChannel(): vscode.OutputChannel {
    if (!makeOutputChannel) {
        makeOutputChannel = vscode.window.createOutputChannel("Autotools", "log");
    }

    return makeOutputChannel;
}

// TODO: process verbosities with enums instead of strings.
// This is a temporary hack.
export function loggingLevelApplies(messageVerbosity: string | undefined): boolean {
    let projectVerbosity: string | undefined = configuration.getLoggingLevel();

    if (messageVerbosity === "Debug") {
        return projectVerbosity === "Debug";
    } else if (messageVerbosity === "Verbose") {
        return projectVerbosity === "Verbose" || projectVerbosity === "Debug";
    }

    return true;
}

export function showOutputChannel(): void {
    if (makeOutputChannel) {
        makeOutputChannel.show(true);
    }
}

export function clearOutputChannel(): void {
    if (makeOutputChannel) {
        makeOutputChannel.clear();
    }
}

//TODO: implement more verbosity levels for the output log
/* if the logging level is "Normal", lines are tuncated to 250 char.
 * If not set, no truncation.
 * if set to other levels, no truncation
 */
export function message(message: string, loggingLevel?: string): void {
    // Print the message only if the intended logging level matches the settings
    // or if no loggingLevel restriction is provided.
    if (!loggingLevelApplies(loggingLevel)) {
        return;
    }

    let channel: vscode.OutputChannel = getOutputChannel();
    channel.appendLine((!loggingLevel || loggingLevel != 'Normal') ? message : truncate(message));
}
const truncate = (input: string) => input.length > 250 ? `${input.substring(0, 250)}...` : input;

// This is used for a few scenarios where the message already has end of line incorporated.
// Example: stdout/stderr of a child process read before the stream is closed.
export function messageNoCR(message: string, loggingLevel?: string): void {
    // Print the message only if the intended logging level matches the settings
    // or if no loggingLevel restriction is provided.
    if (!loggingLevelApplies(loggingLevel)) {
        return;
    }

    let channel: vscode.OutputChannel = getOutputChannel();
    channel.append(message);
}
