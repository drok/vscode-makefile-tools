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
import { BuildTarget, getPackageJSON, TRS, TRS_Info, TRSLookup } from './make';
import * as path from 'path';
import { Scheme } from './tree';
import { assert } from 'console';

nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize: nls.LocalizeFunc = nls.loadMessageBundle();

export const URIFolderIndexRe = /\/(\d+)\/(.*)/;

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
    private rdeps : Set<Goal> = new Set();
    private dependsOn : string | undefined;
    /* All tess ever decorated
     */
    private visibleGoals : Set<Goal> = new Set();

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
            goals.forEach(g => this.rdeps.add(g));
            let newrdeps = Array.from(this.rdeps).map(p => p.getURI());
            newrdeps.length && this._onDidChangeFileDecorations.fire(newrdeps);
        }

        let irrelevantGoals = Array.from(this.visibleGoals.keys())
            .filter(f => !this.rdeps.has(f))
            // .filter(f => !this.relevantFiles.has(f))
            .map(f => f.getURI());
        irrelevantGoals.length && this._onDidChangeFileDecorations.fire(irrelevantGoals);
    }
    public highlightRelevant(goals: Set<Goal> | undefined) {
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
    updateDecorationsRecursive(goals: Set<Goal>) {
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
    goalOf(path: string, goals : Set<Goal>) : [Goal,Goal] | boolean {
        let leaf : [Goal,Goal] | boolean = false;
        let relevantDir : boolean = false;
        let goal_it = goals.values();
        let r: Goal | undefined;
        for (let it = goal_it.next(); !it.done && !r; it = goal_it.next()) {
            let g = it.value;
            let goalpath = g.getFilePath();
            relevantDir = relevantDir || goalpath.startsWith(path);
            let fin = (path == (goalpath) && (leaf=[g,g])) ||
                (g.depends && Array.isArray((leaf=this.goalOf(path, g.depends))));
            relevantDir = relevantDir || (!Array.isArray(leaf) && leaf);
            r = fin ? g : undefined;
        };

        if (r)
            return [r, Array.isArray(leaf) ? leaf[1] : r]
        else
            return relevantDir;
    }
	onDidChangeFileDecorations: vscode.Event<vscode.Uri | vscode.Uri[]> = this._onDidChangeFileDecorations.event;
    private temp : boolean = false;
	provideFileDecoration(
		uri: vscode.Uri,
		_token: vscode.CancellationToken,
	): vscode.ProviderResult<vscode.FileDecoration> {
		// const query = fromFileChangeNodeUri(uri);
        if (uri.scheme == Scheme.Check) {
            let coords = URIFolderIndexRe.exec(uri.path);
            if (coords) {
                let fc = configuration.findFolderConfigByIndex(Number(coords[1]));
                if (fc) {
                    let g = fc.buildTargets
                        .get(coords[1])
                        ?.get("test-suite.log");
                    if (g) {
                        if (g.test?.tags?.includes(live)) {
                            return { tooltip: "live run", badge: '⚡'}
                        }
                        return { badge: ' '};
                    }
                }
            }
        } else
        if (uri.scheme == Scheme.Test) {
            let at = extension._projectTestSuitesProvider.all;
            let goal = at.get(uri.path);
            if (goal) {
                this.visibleGoals.add(goal);
                let testresult = TRS_Info[goal.trs?.results.get(goal.make.ctx.fc.currentTestEnvironment.hashCode) ?? TRS.NONE];
                if (this.rdeps.has(goal)) {
                        let highlighting : vscode.FileDecoration = {
                        badge: `🎯${testresult.badge}`,
                        tooltip: `${testresult.tooltip}, depends on ${this.dependsOn}`,
                        propagate: true
                    };
                    return highlighting;
                } else
                    return testresult;

            }
        } else
        if (uri.scheme == "file") {
            this.visibleFiles.add(uri.path);
            let selected = configuration.currentGoals;
            if (selected != undefined) {
                let goal = this.goalOf(uri.path,new Set(selected));
                if (Array.isArray(goal)) {
                    return { tooltip: `used for ${goal[0].goal}`, badge:
                        // A goal can be the final target, an intemediate puzzle piece,
                        // or the origin/bow
                        goal[0] == goal[1] ?'🎯' :
                        goal[1].depends?.size ? '🧩' : '🏹', propagate: true}; //  ||  || '👁️‍🗨️', propagate: true};
                } else if (!goal)
                    return { color: unused };
            }
        } else
        if (uri.scheme == Scheme.Bin) {
            let at = extension._projectOutlineProvider.all;
            let goal = at.get(uri.path);
            assert(goal, "displayed goals should be known");
            if (goal) {
                this.visibleGoals.add(goal);
                if (this.rdeps.has(goal)) {
                    return { tooltip: `depends on ${this.dependsOn}`,
                        badge: '🎯',
                        propagate: true};
                } else return {
                    tooltip: `${(goal.flags & Goal.Flags.Test_Program) ? 'Test Program' :
                    (goal.flags & Goal.Flags.SharedLib) ? 'Shared Lib' : 'Program'}`,
                }
            }
        } else
        if (uri.scheme == Scheme.Make) {
            let coords = URIFolderIndexRe.exec(uri.path);
            if (coords) {
                let fc = configuration.findFolderConfigByIndex(Number(coords[1]));
                if (fc) {
                    let reldir = path.relative(fc.abs_top_builddir, coords[2]);
                    if (reldir.startsWith('..'))
                        reldir = coords[2];
                    let make = fc.build_tree.ctx.allmakes.get(reldir);
                    if (make)
                        if (make.flags & Make.Flags.LoopFrom) {
                            return { tooltip: "make loop from here", badge: '🔺'}
                        } else if (make.flags && Make.Flags.LoopVia) {
                            return { tooltip: "make loop to here", badge: '🔻'}
                        }
                }
            }
        }


        return undefined; // This will log an error in ExtensionHost about invalid/empty deco
	}
}
