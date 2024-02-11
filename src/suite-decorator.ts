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
import { BuildTarget, getPackageJSON, TRS, TRS_Info, TRSLookup } from './make';
import { makeFullPath } from './util';
import * as path from 'path';
import { NullLogger } from 'vscode-jsonrpc';

nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize: nls.LocalizeFunc = nls.loadMessageBundle();

const unused : vscode.ThemeColor = new vscode.ThemeColor(
    // 'list.warningForeground' ||
    // 'list.errorForeground' ||
    // 'list.invalidItemForeground' ||
    // "list.inactiveFocusBackground" || - no effect
    "disabledForeground"
    );
export class SuiteDecorations implements vscode.FileDecorationProvider {
    private visibleFiles : Set<string> = new Set();
    private relevantFiles : Set<string> = new Set();
	update(resourceUri: vscode.Uri): void {
		this._onDidChangeFileDecorations.fire(resourceUri);
	}

	_onDidChangeFileDecorations: vscode.EventEmitter<vscode.Uri | vscode.Uri[]> = new vscode.EventEmitter<
		vscode.Uri | vscode.Uri[]
	>();

    public updateDecorations(goals: Goal[] | undefined) {
        this.relevantFiles.clear();
        if (goals) this.updateDecorationsRecursive(goals);
        let irrelevant = Array.from(this.visibleFiles.keys())
            .filter(f => !this.relevantFiles.has(f))
            .map(f => vscode.Uri.file(f));
        this._onDidChangeFileDecorations.fire(irrelevant);

        let relevant = Array.from(this.relevantFiles)
            .map( f=> vscode.Uri.file(f));
        this._onDidChangeFileDecorations.fire(relevant);
    }
    updateDecorationsRecursive(goals: Goal[] | undefined) {
        goals?.forEach(g => {
            this.relevantFiles.add(g.getFilePath());
            g.depends && this.updateDecorationsRecursive(g.depends);
        });
    }
    getRelevantFiles() : Set<string> {
        return this.relevantFiles;
    }
    /* finds which of the goal depends the path */
    goalOf(path: string, goals : Goal[]) : Goal | undefined {
        return goals.find(g => path.endsWith(g.goal!) ||
            (g.depends && g.depends.some(g => g.depends && this.goalOf(path, g.depends))));
    }
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
        } else
        if (uri.scheme == "file") {
            this.visibleFiles.add(uri.path);
            let selected = configuration.currentGoals;
            if (selected != undefined) {
                try {
                let goal = this.goalOf(uri.path,selected);
                if (goal) {
                    return { tooltip: `used for ${goal.goal}`, badge: '🎯' || '👁️‍🗨️', propagate: true};
                } else {
                    return { color: unused };
                }
            } catch (e) {
                uri && console.debug("error at ", uri);
            }
            }
        }
        if (!test)
            return {}; // This will log an error in ExtensionHost about invalid/empty deco
        return TRS_Info[test.trs?.results.get(configuration.getCurrentTestEnvironment().hashCode) ?? TRS.NONE];
	}

}
