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
import { globalAgent } from 'http';
import { Scheme } from './tree';

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
    /* all file:// urls that have ever been requested. They will be dimmed
     * when relevant files are being highlighted, and restored to normal color
     * when relevant files are unselected
     */
    private visibleFiles : Set<string> = new Set();
    /* The targets, intermediates and sources that are being highlighted
     * with a badge and a "used by $target" tooltip.
     */
    private relevantFiles : Set<string> = new Set();
    /* highligted reverse deps (test:// targets in the Outline panel)
     */
    private rdeps : Set<string> = new Set();
    private dependsOn : string | undefined;
    /* All tess ever decorated
     */
    private visibleTests : Set<string> = new Set();

	update(resourceUri: vscode.Uri): void {
		this._onDidChangeFileDecorations.fire(resourceUri);
	}

	_onDidChangeFileDecorations: vscode.EventEmitter<vscode.Uri | vscode.Uri[]> = new vscode.EventEmitter<
		vscode.Uri | vscode.Uri[]
	>();

    public highlightTargets(goals: Goal[] | undefined, dependsOn: string | undefined) : void {
        this.rdeps.clear();
        this.dependsOn = dependsOn;

        if (goals) {
            goals.forEach(g =>
                (g.flags & Goal.Flags.Test_Log) && this.rdeps.add(g.getFilePath()) ||
                this.relevantFiles.add(g.getFilePath())
            );
            let newrdeps = Array.from(this.rdeps).map(p => vscode.Uri.from({scheme: Scheme.Test, path: p}));
            newrdeps.length && this._onDidChangeFileDecorations.fire(newrdeps);
        }

        let irrelevant = Array.from(this.visibleTests.keys())
            .filter(f => !this.rdeps.has(f))
            .filter(f => !this.relevantFiles.has(f))
            .map(f => vscode.Uri.from({scheme: Scheme.Test, path: f}));
        irrelevant.length && this._onDidChangeFileDecorations.fire(irrelevant);
    }
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
    /* finds which of the goal depends the path
     * Returns a pair. the first item is the goal being satisfied,
     * the second is the dependency which is at the path
     */
    goalOf(path: string, goals : Goal[]) : [Goal,Goal] | boolean {
        let leaf : [Goal,Goal] | boolean = false;
        let relevantDir : boolean = false;
        let r = goals.find(g => {
                let goalpath = g.getFilePath();
                relevantDir = relevantDir || goalpath.startsWith(path);
                let fin = (path == (goalpath) && (leaf=[g,g])) ||
            (g.depends && Array.isArray((leaf=this.goalOf(path, g.depends))));
                relevantDir = relevantDir || (!Array.isArray(leaf) && leaf);
                return fin;
        });

        if (r)
            return [r, Array.isArray(leaf) ? leaf[1] : r]
        else
            return relevantDir;
    }
	onDidChangeFileDecorations: vscode.Event<vscode.Uri | vscode.Uri[]> = this._onDidChangeFileDecorations.event;
	provideFileDecoration(
		uri: vscode.Uri,
		_token: vscode.CancellationToken,
	): vscode.ProviderResult<vscode.FileDecoration> {
		// const query = fromFileChangeNodeUri(uri);
        let test : Goal | undefined;
        if (uri.scheme == Scheme.Check) {
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
        if (uri.scheme == Scheme.Test) {
            this.visibleTests.add(uri.path);
            let at = extension._projectTestSuitesProvider.allTests;
            test = at.get(uri.path);
            //test = extension._projectTestSuitesProvider.allTests.get(uri.path);
            // if (uri.path.startsWith(configuration.getBuildEnvPath())) {
                // test = extension._projectTestSuitesProvider.allTests[parseInt(uri.query)];
            // }
        } else
        if (uri.scheme == "file") {
            this.visibleFiles.add(uri.path);
            let selected = configuration.currentGoals;
            if (selected != undefined) {
                try {
                let goal = this.goalOf(uri.path,selected);
                if (Array.isArray(goal)) {
                    return { tooltip: `used for ${goal[0].goal}`, badge:
                        // A goal can be the final target, an intemediate puzzle piece,
                        // or the origin/bow
                        goal[0] == goal[1] ?'🎯' :
                        goal[1].depends?.length ? '🧩' : '🏹', propagate: true}; //  ||  || '👁️‍🗨️', propagate: true};
                } else if (!goal)
                    return { color: unused };
                } catch(e) {
                    console.debug("err ", e);
                }
            }
        } else
        if (uri.scheme == Scheme.Bin) {
            this.visibleFiles.add(uri.path);
            let selected = configuration.currentGoals;
            if (selected != undefined) {
                try {
                let goal = this.goalOf(uri.path,selected);
                if (Array.isArray(goal)) {
                    return { tooltip: `used for ${goal[0].goal}`, badge:
                        // A goal can be the final target, an intemediate puzzle piece,
                        // or the origin/bow
                        goal[0] == goal[1] ?'🎯' :
                        goal[1].depends?.length ? '🧩' : '🏹', propagate: true}; //  ||  || '👁️‍🗨️', propagate: true};
                } else if (!goal)
                    return { color: unused };
                } catch(e) {
                    console.debug("err ", e);
                }
            }
        }

        if (!test)
            return {}; // This will log an error in ExtensionHost about invalid/empty deco
        if (this.rdeps.has(uri.path)) {
            let testresult = TRS_Info[test.trs?.results.get(configuration.getCurrentTestEnvironment().hashCode) ?? TRS.NONE];
            let highlighting : vscode.FileDecoration = {
                badge: `🎯${testresult.badge}`,
                tooltip: `${testresult.tooltip}, depends on ${this.dependsOn}`,
                propagate: true
            };
            return highlighting;
        } else
            return TRS_Info[test.trs?.results.get(configuration.getCurrentTestEnvironment().hashCode) ?? TRS.NONE];
	}

}
