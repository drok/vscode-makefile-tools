// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// Tree.ts

import * as configuration from './configuration';
import * as path from 'path';
import * as util from './util';
import { BuildTarget, t_none } from './make';
import { Make, Goal } from './parser/gnumake';
import { TestTask } from './tasks';
import * as vscode from 'vscode';

import * as nls from 'vscode-nls';
import { Extension, extension, telemetry } from './extension';
import { assert } from 'console';
import { Span } from '@opentelemetry/api';
nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize: nls.LocalizeFunc = nls.loadMessageBundle();

interface NamedItem {
    name: string;
}

const _empty = '';

export enum Scheme {
    Test = 'test',
    Check = 'check',
    Bin = 'bin',
    Make = 'make'
}

export abstract class Node {
    // constructor(public readonly id: string) { }
    abstract getTreeItem(): vscode.TreeItem;
    abstract getChildren(): Node[];
    abstract logfile(): string | undefined;
    abstract make : Make;
}

export class SubNode extends Node {
    constructor(public make: Make, public parent: SubNode | undefined | null, private tree : Map<Make, SubNode>,  private flags: number) {
        super();
    }

    getChildren(): Node[] {
        let goals : Node[] = [...this.make.submake.values()]
            .map(sub => this.tree.get(sub)!);
        if (!(this.flags & Goal.Flags.Test_Suite)) {
            goals.push(...[...this.make.goals.values()]
                .filter(goal => (goal.flags & this.flags)));
        } else if (this.make.test_suite?.depends)
            goals.push(...this.make.test_suite.depends);
        return goals;
    }

    private item : vscode.TreeItem | undefined;
    getTreeItem(): vscode.TreeItem {
        if (!this.item) {
            this.item = new vscode.TreeItem(this.make.dir);
            this.item.contextValue = ["nodeType=sub"]
                .concat(((this.flags & Goal.Flags.Test_Suite) && this.make.test_suite) ? ['nodeType=check'] : [])
                .concat((this.flags & Goal.Flags.Linked_binary) ? ['nodeType=allbuild'] : [])
                .join(',');
            this.item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
            if (this.flags & Goal.Flags.Test_Suite) {
                this.item.description = this.make.stats.tests ? localize("autotools.subnode.suite", "{0} tests",
                    this.make.stats.tests) : undefined;
                this.item.resourceUri = vscode.Uri.from({
                        scheme: Scheme.Check,
                        authority: _empty,
                        path: '/' + this.make.dir,
                        query: 'test-suite.log'
                    });
            } else {
                this.item.resourceUri = vscode.Uri.from({
                    scheme: Scheme.Make,
                    authority: _empty,
                    path: '/' + this.make.dir
                });
                this.item.description = this.make.stats.programs ? localize("autotools.subnode.programs", "{0} programs",
                    this.make.stats.programs) : undefined;
            }
            this.item.tooltip =  this.make.dir;
            this.item.id = this.make.dir;
        }
        return this.item;
    }
    makefile() : string {
        if (this.make.dir)
            // If a relative directory, make it absolute wrt. root of workspace
            path.join('', path.join(this.make.dir, 'Makefile.am'));
        return path.join(this.make.dir, 'Makefile.am');
    }
    logfile() : string | undefined {
        if ((this.flags & Goal.Flags.Test_Log) && this.make.dir) {
            return path.join(this.make.dir, 'test-suite.log');
        }
        return undefined;
    }
}

export class ProjectOutlineProvider implements vscode.TreeDataProvider<Node> {
    private readonly _changeEvent = new vscode.EventEmitter<Node | null>();

    private readonly flag: number = Goal.Flags.Linked_binary;
    private tree: Make;
    private subnodes : Map<Make, SubNode> = new Map();
    constructor(span: Span, private configuration: string | undefined) {
        this.tree = new Make('', span, '')
    }

    get onDidChangeTreeData(): any {
        return this._changeEvent.event;
    }
    async getTreeItem(node: Node): Promise<vscode.TreeItem> {
        return node.getTreeItem();
    }
    getChildren(node?: Node): Node[] {
        let goals : Node[];
        if (!node) {
            goals = [this.subnodes.get(this.tree)!];
        } else {
            goals = node.getChildren();
        }
        return goals;
    }
    public getParent(element: Node): vscode.ProviderResult<Node> {
        if (element instanceof SubNode)
            return element.parent;
        else
            return this.subnodes.get(element.make);
    }

    public selectRdepends(path: string) : Goal[] {
        let targets : Goal[] = [];
        try {
        function dependsOnRecursive(path: string, goals: Goal[]) : boolean {
            return goals.some( g => {
                let goalpath = g.getFilePath();
                return (goalpath == path || (g.depends && dependsOnRecursive(path, g.depends)));
            });
        }
        configuration.getAllBuildTargets().forEach((v, k) => {
            v.forEach(g => {
                if ((g.flags & (Goal.Flags.Linked_binary | Goal.Flags.Test_Log)) &&
                    g.depends && dependsOnRecursive(path, g.depends))
                    targets.push(g);
            });
        });
        telemetry.logEvent(extension.journey, "sR", { num: targets.length});
    } catch (e) {
        console.debug("err", e);
    }
        return targets;
    }
    // Updates the tree when build configuration changes
    public all : Map<string,Goal> = new Map();
    async update(configuration: string): Promise<void> {
        this.configuration = configuration;
        this.updateTree();
    }

    clear() : void {
        this.updateTargets(new Make('', extension.journey, ''));
    }
    // Updates the tree when settings.json changes
    updateTargets(build_tree: Make) : void {
        this.tree = build_tree;
        this.subnodes.clear();
        buildParents(build_tree, undefined, this.subnodes, this.flag);
        this.updateTree();
    }

    updateTree(): void {
        this._changeEvent.fire(null);
    }
}

function buildParents(tree: Make, parent: SubNode | undefined | null, parents: Map<Make, SubNode>, flags : number, depth: number = 0) : SubNode {
    let myNode = new SubNode(tree, parent, parents, flags);
    if (depth > 10) // Avoid infinite loop. a dependency tree 10-deep should be enough for everyone
        return myNode;
    for (const [dir,m] of tree.submake) {
        parents.set(m, buildParents(m, myNode, parents, flags, depth+1));
    }
    parents.set(tree, myNode);
    return myNode;
}

export class ProjectTestsProvider implements vscode.TreeDataProvider<Node> {
    private readonly _changeEvent = new vscode.EventEmitter<Node | null>();

    private readonly flag : number = Goal.Flags.Test_Suite;
    private tree: Make;
    private subnodes : Map<Make, SubNode> = new Map();
    constructor(span: Span) {
        this.tree = new Make('', span, '')
    }

    public refresh(): any {
        this._changeEvent.fire(null);
    }

    get onDidChangeTreeData(): any {
        return this._changeEvent.event;
    }
    async getTreeItem(node: Node): Promise<vscode.TreeItem> {
        return node.getTreeItem();
    }
    getChildren(node?: Node): Node[] {
        let goals : Node[];
        if (!node) {
            if (!this.tree.stats.checks)
                return []; // ie, show the welcome message

            goals = [this.subnodes.get(this.tree)!];
            if (this.tree.test_suite?.depends)
                goals
                .push(...this.tree.test_suite.depends);
        } else {
            goals = node.getChildren();
        }
        return goals;
    }
    public getParent(element: Node): vscode.ProviderResult<Node> {
        if (element instanceof SubNode)
            return element.parent;
        else
            return this.subnodes.get(element.make);
    }

    pathDisplayed(pathInSettings: string | undefined, kind: string, searchInPath: boolean, makeRelative: boolean): string {
       if (!pathInSettings) {
         return `${kind}: [Unset]`;
       }

       const pathBase: string | undefined = (searchInPath && path.parse(pathInSettings).dir === "") ? path.parse(pathInSettings).base : undefined;
       const pathInEnv: string | undefined = pathBase ? (path.join(util.toolPathInEnv(pathBase) || "", pathBase)) : undefined;
       const finalPath: string = pathInEnv || pathInSettings;
       let checkFileExists: boolean = pathInSettings !== undefined;

       return (!checkFileExists ? `${kind} (not found)` : `${kind}`) + `: [${makeRelative ? util.makeRelPath(finalPath, util.getWorkspaceRoot()) : finalPath}]`;
    }

    // Updates the tree when build configuration changes
    // alltests is an array used to find the decoration for each test
    public all : Map<string,Goal> = new Map();
    async update(configuration: string): Promise<void> {
        this.allTests = [];
        this.updateTree();
    }

    clear() : void {
        this.updateTargets(new Make('', extension.journey, ''));
    }
    // Updates the tree when settings.json changes
    updateTargets(build_tree: Make) : void {
        this.tree = build_tree;
        this.subnodes.clear();
        buildParents(build_tree, undefined, this.subnodes, this.flag);
        this.updateTree();
    }

    updateTree(): void {
        this.all.clear(); // it will be refilled with goals that are currently displayed
        this._changeEvent.fire(null);
    }
}
