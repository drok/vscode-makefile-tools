// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// Tree.ts

import * as configuration from './configuration';
import * as path from 'path';
import * as util from './util';
import { Make, Goal, MakeContext } from './parser/gnumake';
import * as vscode from 'vscode';
import {
    ThemeColor, ThemeIcon,
    WorkspaceFolder } from 'vscode';

import * as nls from 'vscode-nls';
import { extension, telemetry } from './extension';
import { Span } from '@opentelemetry/api';
import { envHash, FolderConfig } from './configuration';
import { TreeItem } from 'vscode';
nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize: nls.LocalizeFunc = nls.loadMessageBundle();

const _empty = '';

export enum Scheme {
    Test = 'test',
    Check = 'check',
    Bin = 'bin',
    Make = 'make'
}

export abstract class Node {
    // constructor(public readonly id: string) { }
    abstract getTreeItem(state: vscode.TreeItemCollapsibleState, provider?: vscode.TreeDataProvider<Node>): vscode.TreeItem;
    abstract getChildren(): Node[];
    abstract logfile(): string | undefined;
    abstract make : Make;
}

export class SubNode extends Node {
    constructor(public make: Make, public parent: SubNode | undefined | null, public tree : Map<Make, SubNode>,  private flags: number) {
        super();
    }
    private disableSuite : boolean = false;
    private static readonly iconColor = new ThemeColor('minimap.warningHighlight');
    private static readonly RecursiveDir = new ThemeIcon('alert', this.iconColor);

    getChildren(): Node[] {
        // Some of the submakes are not in a loop
        let gg = [...this.make.submake.values()]
            .filter(m => !(m.flags & Make.Flags.LoopVia));
        if (this.flags & Goal.Flags.Test_Suite) {
            gg = gg.filter(g => g.stats.tests)
        }
        let goals : Node[] = gg
            .map(sub => this.tree.get(sub)!);
        if (!(this.flags & Goal.Flags.Test_Suite)) {
            goals.push(...[...this.make.goals.values()]
                .filter(goal => (goal.flags & this.flags)));
        } else if (this.make.test_suite?.depends)
            goals.push(...this.make.test_suite.depends);
        return goals;
    }
    // Like getChildren but filtered for dirs of testenvironments
    getDirChildren() : Node[] {
        let gg = [...this.make.submake.values()]
            .filter(m => !(m.flags & Make.Flags.LoopVia));
        if (this.flags & Goal.Flags.Test_Suite) {
            gg = gg.filter(g => g.stats.tests)
        }
        let goals : Node[] = gg
            .map(sub => this.tree.get(sub)!);
        return goals;
    }
    noSuite(en: boolean) : void {
        this.disableSuite = en;
    }
    private item : vscode.TreeItem | undefined;
    resetItem() : void { this.item = undefined; }
    getTreeItem(state: vscode.TreeItemCollapsibleState, provider?: vscode.TreeDataProvider<Node>): vscode.TreeItem {
        if (!this.item) {
            let isTestSuite = !!(this.flags & Goal.Flags.Test_Suite);
            let label = this.parent ? (this.make.dir ?? "<buildDir>") : (
                isTestSuite ? `${this.make.ctx.fc.folder.name}` :
                this.make.ctx.fc.getProjectName()
            );

            this.item = new vscode.TreeItem(label);
            this.item.collapsibleState = state; // vscode.TreeItemCollapsibleState.Collapsed;
            if (this.make.flags & Make.Flags.LoopFrom)
                this.item.iconPath = SubNode.RecursiveDir;

            this.item.id = this.parent ?
                `${this.parent.item?.id},${this.make.dir}` :
                `${this.make.ctx.fc.folder.index},${this.make.dir}`;
            if (isTestSuite) {
                if (this.make.test_suite) this.item.iconPath = Goal.CheckIcon;
                this.item.description = this.item.id ? (this.make.stats.tests ? localize("autotools.subnode.suite", "{0} tests",
                    this.make.stats.tests) : undefined) : this.make.ctx.fc.currentTestEnvironment.name;
                this.item.resourceUri = vscode.Uri.from({
                        scheme: Scheme.Check,
                        authority: _empty,
                        path: this.make.getDir(),
                        query: 'test-suite.log'
                    });
                this.item.tooltip = this.make.dir || this.make.ctx.root;
            } else {
                this.item.resourceUri = vscode.Uri.from({
                    scheme: Scheme.Make,
                    authority: _empty,
                    path: '/' + this.make.ctx.fc.folder.index + '/' + this.make.getDir()
                });
                // FIXME: This GetItem is called before parse, to set commands.
                // The description needs to be updated after parse
                this.item.description = this.item.id ? (this.make.stats.programs ? localize("autotools.subnode.programs", "{0} programs",
                    this.make.stats.programs) : undefined) : this.make.ctx.fc.buildConfig.name;
                this.item.tooltip =
                    (this.make.stats.sharedlibs && this.make.stats.testbins) ?
                    localize("autotools.subnode.programs.tooltip.ST", "{0}: {1} shared libs, {2} test programs",
                        this.make.dir || this.make.ctx.root, this.make.stats.sharedlibs, this.make.stats.testbins) :
                    (this.make.stats.sharedlibs) ?
                    localize("autotools.subnode.programs.tooltip.S", "{0}: {1} shared libs",
                        this.make.dir || this.make.ctx.root, this.make.stats.sharedlibs) :
                    (this.make.stats.testbins) ?
                    localize("autotools.subnode.programs.tooltip.S", "{0}: {1} test programs",
                        this.make.dir || this.make.ctx.root, this.make.stats.testbins) :
                    this.make.dir || this.make.ctx.root;
            }
            let context : string[] = ["nodeType=sub"];
            if (!this.parent) { // Top of the tree
                let fc = this.make.ctx.fc;
                context.push('folderNode');
                if (fc.isAutotoolsProject) context.push('isAutotoolsProject')
                if (fc.isBootstrapped) context.push('isBootstrapped');
                if (fc.isConfigured) context.push('isConfigured');
                if (fc.build_tree.stats.programs) context.push('hasTargets');
                if (fc.pkginfo?.bugreport) context.push('hasBugReport');
                if (fc.pkginfo?.url) context.push('hasPackageUrl');
                if (!path.isAbsolute(fc.buildConfig.top_builddir)) context.push('relBuildDir');
                if (fc.gTestEnvironment.XFAIL_TESTS?.length) context.push('haveGlobalWaivers');
            }
            this.item.contextValue = context
                .concat((!this.disableSuite && (this.flags & Goal.Flags.Test_Suite) && this.make.test_suite) ? ['nodeType=check'] : [])
                .join(',');
        } else
            return this.item;
        return this.item;
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
    private trees: Map<FolderConfig, Make>;
    private subnodes : Map<FolderConfig, Map<Make, SubNode>> = new Map();
    constructor() {
        this.trees = new Map();
    }

    get onDidChangeTreeData(): any {
        return this._changeEvent.event;
    }
    getTreeItem(node: Node): vscode.TreeItem {
        if (node instanceof SubNode) {
            let state = node.make.ctx.fc.state.expandedMakes.includes(subHash(node)) ?
            vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
            return node.getTreeItem(state, this);
        }
        return node.getTreeItem(vscode.TreeItemCollapsibleState.None, this);
    }
    getChildren(node?: Node): Node[] {
        let goals : Node[];
        if (!node) {
            goals = Array.from(this.trees.entries())
                .sort((a,b) => a[0].folder.index - b[0].folder.index)
                .map(([fc,m]) => this.subnodes.get(fc)!.get(m)!);
        } else {
            goals = node.getChildren();
        }
        return goals;
    }
    public getParent(element: Node): vscode.ProviderResult<Node> {
        if (element instanceof SubNode)
            return element.parent;
        else
            return this.subnodes.get(element.make.ctx.fc)!
                .get(element.make);
    }

    public selectRdepends(uri: vscode.Uri) : Goal[] {
        let targets : Goal[] = [];

        let fc = configuration.findFolderConfig(uri);
        if (fc) {
            function dependsOnRecursive(path: string, goals: Goal[]) : boolean {
                return goals.some( g => {
                    let goalpath = g.getFilePath();
                    return (goalpath == path || (g.depends && dependsOnRecursive(path, g.depends)));
                });
            }
            fc.buildTargets.forEach((v, k) => {
                v.forEach(g => {
                    if ((g.flags & (Goal.Flags.Linked_binary | Goal.Flags.Test_Log)) &&
                        g.depends && dependsOnRecursive(uri.path, g.depends))
                        targets.push(g);
                });
            });
        }
        telemetry.logEvent(extension.journey, "sR", { num: targets.length});
        return targets;
    }
    // Updates the tree when build configuration changes
    public all : Map<string,Goal> = new Map();
    async update(fc: FolderConfig): Promise<void> {
        // this.configuration = "Available Label";
        // this.subnodes.get(this.trees.get(fc)!)
        this.updateTree(this.subnodes.get(fc)!.get(fc.build_tree)!);
    }

    removeFolder(fc: FolderConfig) : void {
        this.trees.delete(fc);
        this.subnodes.delete(fc);
        this._changeEvent.fire(null);
    }
    // Updates the tree when settings.json changes
    updateTargets(fc: FolderConfig, update: boolean) : void {
        let firstPaint = !this.trees.size;
        this.trees.set(fc, fc.build_tree);
        let oldtop = this.subnodes.get(fc)?.get(fc.build_tree);
        let nodeMap = new Map();
        this.subnodes.set(fc, nodeMap);
        let newtop = buildParents(fc.build_tree, undefined, oldtop, nodeMap, this.flag);
        (update || !firstPaint) && this.updateTree(!firstPaint ? null : oldtop ?? newtop);
    }

    updateTree(top: SubNode | null): void {
        this._changeEvent.fire(top);
    }
}

function buildParents(tree: Make, parent: SubNode | undefined | null, oldtop: SubNode | undefined, parents: Map<Make, SubNode>, flags : number, depth: number = 0) : SubNode {
    let myNode = oldtop ?? new SubNode(tree, parent, parents, flags);
    if (oldtop) {
        oldtop.tree = parents;
        oldtop.resetItem();
    }
    if (depth > 10) // Avoid infinite loop. a dependency tree 10-deep should be enough for everyone
        return myNode;
    for (const [dir,m] of tree.submake) {
        if (!parents.has(m)) {
            /* Don't overwrite. in infinite dir loops, this means all the leaf items
             * will appear at the top-most instance a subnode. */
            parents.set(m, myNode); // set something so child will detect has()
            let newParent = buildParents(m, myNode, undefined, parents, flags, depth+1);
            parents.set(m, newParent);
        }
    }
    parents.set(tree, myNode);
    return myNode;
}

export class ProjectTestsProvider implements vscode.TreeDataProvider<Node> {
    private readonly _changeEvent = new vscode.EventEmitter<Node | null>();

    private readonly flag : number = Goal.Flags.Test_Suite;
    private trees: Map<FolderConfig, Make>;
    private subnodes : Map<FolderConfig, Map<Make, SubNode>> = new Map();
    private env: configuration.TestEnvironment | undefined;
    constructor() {
        this.trees = new Map();
    }

    get onDidChangeTreeData(): any {
        return this._changeEvent.event;
    }
    getTreeItem(node: Node): vscode.TreeItem {
        if (node instanceof SubNode) {
            let state = node.make.ctx.fc.state.expandedChecks.includes(subHash(node)) ?
            vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
            return node.getTreeItem(state, this);
        }
        return node.getTreeItem(vscode.TreeItemCollapsibleState.None);
    }
    getChildren(node?: Node): Node[] {
        let goals : Node[];
        if (!node) {
            // will show the welcome message if no trees have checks
            goals = Array.from(this.trees.entries())
                .sort((a,b) => a[0].folder.index - b[0].folder.index)
                .filter(([k,v]) => v.stats.checks)
                .map(([fc,m]) => this.subnodes.get(fc)!.get(m)!);
        } else
          if (!this.env || !this.env?.dirs || this.env.dirs.includes(node.make.dir))
            goals = node.getChildren();
          else if (node instanceof SubNode)
            goals = node.getDirChildren();
          else
            return [];
        // turn off the suite in all subdirs that are not in the dirs
        // FIXME: find a better way. This forEach is done for every node.
        goals.forEach(g => {
            if (g instanceof SubNode)
                g.noSuite(!!this.env && !!this.env.dirs && !this.env!.dirs!.includes(g.make.dir));
        });
        return goals;
    }
    public getParent(element: Node): vscode.ProviderResult<Node> {
        if (element instanceof SubNode)
            return element.parent;
        else
            return this.subnodes.get(element.make.ctx.fc)!
                .get(element.make);
}

    // Updates the tree when build configuration changes
    // alltests is an array used to find the decoration for each test
    public all : Map<string,Goal> = new Map();
    async update(fc: FolderConfig): Promise<void> {
        this.updateTree(this.subnodes.get(fc)!.get(fc.build_tree)!);
    }

    removeFolder(fc: FolderConfig) : void {
        this.trees.delete(fc);
        this.subnodes.delete(fc);
        this._changeEvent.fire(null);
    }
    // Updates the tree when settings.json changes
    updateTargets(fc: FolderConfig, update: boolean) : void {
        let firstPaint = !this.trees.size;
        this.trees.set(fc, fc.build_tree);
        let oldtop = this.subnodes.get(fc)?.get(fc.build_tree);
        let nodeMap = new Map();
        this.subnodes.set(fc, nodeMap);
        let newtop = buildParents(fc.build_tree, undefined, oldtop, nodeMap, this.flag);
        (update || !firstPaint) && this.updateTree(!firstPaint ? null : oldtop ?? newtop);
    }

    updateTree(top: SubNode | null): void {
        this._changeEvent.fire(top);
    }
    // updateTreeItems(fc: FolderConfig): void {
    //     this.updateTree(this.subnodes.get(fc)!.get(fc.build_tree)!);
    // }
}
export function subHash(sub: SubNode): number {
    return envHash(`${sub.make.ctx.fc.folder.name}/${sub.make.dir}`);
}
