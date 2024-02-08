/* 
 * Copyright (c) 2023 Radu Hociung
 * All rights reserved.
 */
import * as vscode from 'vscode';
import * as configuration from './configuration';
import { Extension, extension  } from './extension';
import { Goal, Make } from './parser/gnumake';
import { live } from './test';

import * as nls from 'vscode-nls';
import { PassThrough } from 'stream';
import { BuildTarget, TRS, TRS_Info, TRSLookup } from './make';
import { makeFullPath } from './util';
import * as path from 'path';

nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize: nls.LocalizeFunc = nls.loadMessageBundle();

export class SuiteDecorations implements vscode.FileDecorationProvider {
            
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
		// const query = fromFileChangeNodeUri(uri);
        let test : Goal | undefined;
        if (uri.scheme == "check") {
            let goals = configuration.getAllBuildTargets();
            let g = goals
                .get(uri.path.substring(1))
                ?.get("test-suite.log");
            if (g?.test?.tags?.includes(live)) {
                return { tooltip: "live run", badge: '⚡'}
            }
//            let sub = configuration.getAllBuildTargets()
//                .get(uri.path.substring(1));
//            let test = sub?.get(uri.query);
//            if (test)
//                return  { /* tooltip: "pass: 100/2000", badge: "99", */
//                    color: ((test?.flags & Goal.Flags.Test_Result_Mask) == TRS.PASS) ? undefined :  SuiteDecorations.check_err };
//            else
                return { badge: ' '};
        } else
        if (uri.scheme == "test") {
            if (uri.path.startsWith(configuration.getBuildEnvPath())) {
                //let at = extension._projectTestSuitesProvider.allTests;
                test = extension._projectTestSuitesProvider.allTests[parseInt(uri.query)];
            }
        }
        if (!test)
            return {}; // This will log an error in ExtensionHost about invalid/empty deco
        return TRS_Info[test.trs?.results.get(configuration.getCurrentTestEnvironment().hashCode) ?? TRS.NONE];
	}

}
