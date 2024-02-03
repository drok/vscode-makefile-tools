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
import { Extension, extension } from './extension';
import { assert } from 'console';
nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize: nls.LocalizeFunc = nls.loadMessageBundle();

interface NamedItem {
    name: string;
}

export abstract class Node {
    // constructor(public readonly id: string) { }
    abstract getTreeItem(): vscode.TreeItem;
    abstract getChildren(): Node[];
    abstract logfile(): string | undefined;
}

export class SubNode extends Node {
    constructor(public submake: Make, private flags: number) {
        super();
    }

    getChildren(): Node[] {
        let goals : Node[] = [...this.submake.submake.values()]
            .map(sub => new SubNode(sub, this.flags));
        if (!(this.flags & Goal.Flags.Test_Suite)) {
            goals.push(...[...this.submake.goals.values()]
                // Bit of a hack to hardcode excluding test_program
                .filter(goal => (goal.flags & this.flags) && !(goal.flags & Goal.Flags.Test_Program)));
        } else if (this.submake.test_suite?.depends)
            goals.push(...this.submake.test_suite.depends);
        return goals;
    }

    private item : vscode.TreeItem | undefined;
    getTreeItem(): vscode.TreeItem {
        if (!this.item) {
            this.item = new vscode.TreeItem(this.submake.dir);
            this.item.contextValue = ["nodeType=sub"]
                .concat(((this.flags & Goal.Flags.Test_Suite) && this.submake.test_suite) ? ['nodeType=check'] : [])
                .concat((this.flags & Goal.Flags.Linked_binary) ? ['nodeType=allbuild'] : [])
                .join(',');
            this.item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
            if (this.flags & Goal.Flags.Test_Suite) {
                this.item.description = this.submake.stats.tests ? localize("autotools.subnode.suite", "{0} tests",
                    this.submake.stats.tests) : undefined;
                this.item.resourceUri = vscode.Uri.from({
                        scheme: "check",
                        authority: Extension.whoami,
                        path: '/' + this.submake.dir,
                        query: 'test-suite.log'
                    });
            } else {
                this.item.description = this.submake.stats.programs ? localize("autotools.subnode.programs", "{0} programs",
                    this.submake.stats.programs) : undefined;
            }
            this.item.tooltip =  this.submake.dir;
        }
        return this.item;
    }
    makefile() : string {
        if (this.submake.dir)
            // If a relative directory, make it absolute wrt. root of workspace
            path.join('', path.join(this.submake.dir, 'Makefile.am'));
        return path.join(this.submake.dir, 'Makefile.am');
    }
    logfile() : string | undefined {
        if ((this.flags & Goal.Flags.Test_Log) && this.submake.dir) {
            return path.join(this.submake.dir, 'test-suite.log');
        }
        return undefined;
    }
}

export class TaskSection extends Node {
    constructor(private tree: Make, private _name: string, private flag: number) {
        super();
    }

//    update(targetName: BuildTarget): void {
//        this._name = localize("tree.build.target", "Build target: {0}", `[${targetName.goal} @ ${targetName.builddir}]`);
//    }

    getChildren(): Node[] {
            let goals : Node[] = [...this.tree.submake.values()]
                .map(sub => new SubNode(sub, this.flag));
            goals.push(...[...this.tree.goals.values()]
                .filter(goal => goal.flags & this.flag));
            if ((this.flag & Goal.Flags.Test_Suite) && this.tree.test_suite?.depends)
                goals.push(...this.tree.test_suite.depends);
            return goals;
    }

    getTreeItem(): vscode.TreeItem {
        const item: vscode.TreeItem = new vscode.TreeItem(this._name);
        // item.tooltip = localize("makefile.target.currently.selected.for.build", "The target currently selected for build.");
        item.contextValue = [
            `nodeType=section.` + this._name,
            "nodeType=sub"]
            .concat((this.flag & Goal.Flags.Test_Suite) ? ['nodeType=allcheck'] : [])
            .concat((this.flag & Goal.Flags.Linked_binary) ? ['nodeType=allbuild'] : [])
            .join(',');
        if (this.flag & Goal.Flags.Test_Suite) {
            item.description = localize("autotools.subnode.suite", "{0} tests, {1} subdirs",
                this.tree.stats.tests, this.tree.stats.subdirs);
            item.collapsibleState =
                this.tree.stats.tests ?
                    vscode.TreeItemCollapsibleState.Expanded :
                    vscode.TreeItemCollapsibleState.Collapsed;
            item.resourceUri = vscode.Uri.from({
                    scheme: "check",
                    authority: Extension.whoami,
                    path: '/',
                    query: 'test-suite.log'
                });
            item.tooltip = new vscode.MarkdownString("[Test suite](https://www.gnu.org/software/automake/manual/html_node/Parallel-Test-Harness.html) logs");
        } else {
            item.description = localize("autotools.subnode.programs", "{0} programs, {1} subdirs",
                this.tree.stats.programs, this.tree.stats.subdirs);
            item.collapsibleState =
                this.tree.stats.programs ?
                    vscode.TreeItemCollapsibleState.Expanded :
                    vscode.TreeItemCollapsibleState.Collapsed;
            item.tooltip = new vscode.MarkdownString("[Built programs](https://www.gnu.org/software/automake/manual/html_node/Program-Sources.html)");
        }
        return item;
    }
    makefile() : string {
        if (this.tree.dir)
            // If a relative directory, make it absolute wrt. root of workspace
            path.join('', path.join(this.tree.dir, 'Makefile.am'));
        return path.join(this.tree.dir, 'Makefile.am');
    }
    logfile() : string | undefined {
        if ((this.flag & Goal.Flags.Test_Log))
            return path.join(this.tree.dir, 'test-suite.log');
        return undefined;
    }
}

export class ConfigurationNode extends Node {
    constructor(private _name : string | undefined, private build_tree: Make) {
        super();
        // super(`configuration:${configurationName}`);
    }

//    private hasGoalKind(flag: number) : boolean {
//        
//    }
    getChildren(): Node[] {
        let children: Node[] = [];
        if (!this.build_tree)
            return children;
        //if (true)
        return [
            new TaskSection(this.build_tree, 'Programs', Goal.Flags.Linked_binary),
        // if (this.build_tree.goals.some(goal => goal.goal == "check"))
            new TaskSection(this.build_tree, 'Test Suites', Goal.Flags.Test_Suite),
        ];
        //return children;
    }
    public getParent(element: Node): Node | undefined {
        //const parent = element. resource.with({ path: dirname(element.resource.path) });
        // return parent.path !== '//' ? { resource: parent, isDirectory: true } : undefined;
        return {} as Node;
    }

    getTreeItem(): vscode.TreeItem {
        const item: vscode.TreeItem = new vscode.TreeItem(this._name || "unk");
        item.collapsibleState = this.build_tree ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None;
        item.tooltip = "top_builddir = " + configuration.getCurrentMakefileConfiguration().top_builddir;
        item.contextValue = [
            `nodeType=configuration`,
        ].join(',');
        return item;
    }
    logfile(): string | undefined {
        return undefined;
    }
}

export class ProjectOutlineProvider implements vscode.TreeDataProvider<Node> {
    private readonly _changeEvent = new vscode.EventEmitter<Node | null>();
    //private readonly _unsetString = localize("Unset", "Unset");

    constructor(private configuration: string | undefined) {
    }

    private tree: Make = new Make('', '');

    get onDidChangeTreeData(): any {
        return this._changeEvent.event;
    }
    async getTreeItem(node: Node): Promise<vscode.TreeItem> {
        return node.getTreeItem();
    }
    getChildren(node?: Node): Node[] {
        let goals : Node[];
        if (!node) {
            goals = [...this.tree.submake.values()]
                .map(sub => new SubNode(sub, Goal.Flags.Linked_binary));
            goals.push(...[...this.tree.goals.values()]
                .filter(goal => goal.flags & Goal.Flags.Linked_binary));
        } else {
            goals = node.getChildren();
        }
        return goals;
    }
    public getParent(element: Node): Node | undefined {
        if (!(element instanceof ConfigurationNode))
            throw new Error("Unexpected request for parent of non-ConfigurationNode");
        return element instanceof ConfigurationNode ? undefined : {} as Node;
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
    async update(configuration: string): Promise<void> {
        this.configuration = configuration;
        this.updateTree();
    }

    // Updates the tree when settings.json changes
    updateTargets(build_tree: Make) : void {
        this.tree = build_tree;
        this.updateTree();
    }

    updateTree(): void {
        this._changeEvent.fire(null);
    }
}

export class ProjectTestsProvider implements vscode.TreeDataProvider<Node> {
    private readonly _changeEvent = new vscode.EventEmitter<Node | null>();

    constructor() {
    }
    private tree: Make = new Make('', '');

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
            goals = [...this.tree.submake.values()]
                .map(sub => new SubNode(sub, Goal.Flags.Test_Suite));
            goals.push(...[...this.tree.goals.values()]
                .filter(goal => goal.flags & Goal.Flags.Test_Suite));
            if (this.tree.test_suite?.depends)
                goals
                .push(...this.tree.test_suite.depends);
        } else {
            goals = node.getChildren();
        }
        return goals;
    }
    public getParent(element: Node): Node | undefined {
        if (!(element instanceof ConfigurationNode))
            throw new Error("Unexpected request for parent of non-ConfigurationNode");
        return element instanceof ConfigurationNode ? undefined : {} as Node;
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
    async update(configuration: string): Promise<void> {
        this.updateTree();
    }

    // Updates the tree when settings.json changes
    updateTargets(build_tree: Make) : void {
        this.tree = build_tree;
        this.updateTree();
    }

    updateTree(): void {
        this._changeEvent.fire(null);
    }
}
