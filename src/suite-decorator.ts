/* 
 * Copyright (c) 2023 Radu Hociung
 * All rights reserved.
 */
import * as vscode from 'vscode';
import * as configuration from './configuration';
import { Goal } from './parser/gnumake';

import * as nls from 'vscode-nls';
import { PassThrough } from 'stream';
nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize: nls.LocalizeFunc = nls.loadMessageBundle();

export class SuiteDecorations implements vscode.FileDecorationProvider {
    static check_err = new vscode.ThemeColor("testing.message.error.decorationForeground");
	update(resourceUri: vscode.Uri): void {
		this._onDidChangeFileDecorations.fire(resourceUri);
	}

	_onDidChangeFileDecorations: vscode.EventEmitter<vscode.Uri | vscode.Uri[]> = new vscode.EventEmitter<
		vscode.Uri | vscode.Uri[]
	>();
	onDidChangeFileDecorations: vscode.Event<vscode.Uri | vscode.Uri[]> = this._onDidChangeFileDecorations.event;
	provideFileDecoration(
		uri: vscode.Uri,
		_token: vscode.CancellationToken,
	): vscode.ProviderResult<vscode.FileDecoration> {
        if (uri.authority != 'autotools')
            return undefined;
		// const query = fromFileChangeNodeUri(uri);
        let test : Goal | undefined;
        if (uri.scheme == "check") {
            let goals = configuration.getAllBuildTargets();
            let g = goals
                .get(uri.path.substring(1));
            test = g
                ?.get(uri.query);
        } else if (uri.scheme == "test") {
            let goals = configuration.getAllBuildTargets();
            let g = goals
                .get(uri.path.substring(1));
            let suite : Goal | undefined = g?.get("test-suite.log");
            test = suite
                ?.depends?.find(t => t.goal == uri.query);
        }
        if (!test)
            return undefined;
        if (test.flags & Goal.Flags.Test_Passed)
            return SuiteDecorations.pass;
        else if (test.flags & Goal.Flags.Test_Failed)
            return SuiteDecorations.fail;
        return SuiteDecorations.unk;
	}

}
