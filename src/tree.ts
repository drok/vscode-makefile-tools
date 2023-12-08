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

function countStats(sub: Make): number[] {
    // let total : number = 0;
    // let num_dirs : number = 0;
    sub.stats.subdirs = sub.submake.size;
    for (let submake of sub.submake.values()) {
        let [t, n, s, c] = countStats(submake);
        sub.stats.programs += t;
        sub.stats.tests += n;
        sub.stats.subdirs += s;
        sub.stats.checks += c;
    }
    for (let [goal, g] of sub.goals)
        sub.stats.programs += ((g.flags & Goal.Flags.Linked_binary)
            && !(g.flags & Goal.Flags.Test_Program)) ? 1 : 0;

    let numTestsHere = (sub.goals.get("test-suite.log")?.depends?.length ?? 0);
    sub.stats.tests += numTestsHere;
    sub.stats.checks += (numTestsHere ? 1 : 0);
    return [
        sub.stats.programs,
        sub.stats.tests,
        sub.submake.size,
        sub.stats.checks
    ];
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
                .filter(goal => (goal.flags & this.flags) && !(goal.flags & Goal.Flags.Test_Program))
                .map(goal => new TaskNode(goal)));
        } else if (this.submake.test_suite?.depends)
            goals.push(...this.submake.test_suite.depends
                    .map(test => new TaskNode(test)));
        return goals;
    }

    getTreeItem(): vscode.TreeItem {
        const item: vscode.TreeItem = new vscode.TreeItem(this.submake.dir);
        item.contextValue = ["nodeType=sub"]
            .concat(((this.flags & Goal.Flags.Test_Log) && this.submake.test_suite) ? ['nodeType=check'] : [])
            .concat((this.flags & Goal.Flags.Linked_binary) ? ['nodeType=allbuild'] : [])
            .join(',');
        item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
        if (this.flags & Goal.Flags.Test_Suite) {
            item.description = localize("autotools.subnode.suite", "{0} tests, {1} subdirs",
                this.submake.stats.tests, this.submake.stats.subdirs);
            item.resourceUri = vscode.Uri.from({
                    scheme: "check",
                    authority: Extension.whoami,
                    path: '/' + this.submake.dir,
                    query: 'test-suite.log'
                });
        } else {
            item.description = localize("autotools.subnode.programs", "{0} programs, {1} subdirs",
                this.submake.stats.programs, this.submake.stats.subdirs);
        }
        item.tooltip =  this.submake.dir;
        return item;
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

export class TaskNode extends Node {
    constructor(public goal: Goal) {
        super();
    }

    getChildren(): Node[] {
        return [];
    }

    getTreeItem(): vscode.TreeItem {
        if (!this.goal.goal)
            throw new Error("Unexpected null goal");
        const item: vscode.TreeItem = new vscode.TreeItem(this.goal.goal);
        item.collapsibleState = vscode.TreeItemCollapsibleState.None;
        item.tooltip = this.goal.goal;
        item.contextValue = ["nodeType=task"]
            .concat((this.goal.flags & Goal.Flags.Linked_binary) ? ['nodeType=build'] : [])
//            .concat((this.goal.flags & Goal.Flags.Test_Progam) ? ['nodeType=test'] : [])
            .concat((this.goal.flags & Goal.Flags.Test_Log) ? ['nodeType=test'] : [])
            .concat((this.goal.flags & Goal.Flags.Test_Log) &&
                // Add different kind of supported test programs here
                (this.goal.depends && (this.goal.depends[0].flags & Goal.Flags.Linked_binary)) ? ['nodeType=bintest'] : [])
            .join(',');
        if (!this.goal.task)
            return item;

        if (this.goal.flags & Goal.Flags.Test_Log) {
            const definition: TestTask = <any>this.goal.task.definition;
            item.resourceUri = vscode.Uri.from({
                scheme: "test",
                authority: Extension.whoami,
                path: '/' +  definition.test?.builddir,
                query:  this.goal.goal,
            });
        }
        return item;
    }
    logfile() : string | undefined {
        if (!this.goal.task)
            return undefined;
        if ((this.goal.flags & Goal.Flags.Test_Log)) {
            const definition: TestTask = <any>this.goal.task.definition;
            if (definition.test)
                return path.join(definition.test.builddir, definition.test.goal);
        }
        return undefined;
    }

}


export class TaskSection extends Node {
    constructor(build_tree: Make, name: string, flag: number) {
        super();
        this.tree = build_tree;
        this._name = name;
        this.flag = flag;
    }

    tree: Make;
    flag: number;
    _name: string;

//    update(targetName: BuildTarget): void {
//        this._name = localize("tree.build.target", "Build target: {0}", `[${targetName.goal} @ ${targetName.builddir}]`);
//    }

    getChildren(): Node[] {
            let goals : Node[] = [...this.tree.submake.values()]
                .map(sub => new SubNode(sub, this.flag));
            goals.push(...[...this.tree.goals.values()]
                .filter(goal => goal.flags & this.flag)
                .map(goal => new TaskNode(goal)));
            if ((this.flag & Goal.Flags.Test_Suite) && this.tree.test_suite?.depends)
                goals.push(...this.tree.test_suite.depends
                    .map(test => new TaskNode(test)));
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
    constructor(private _name : string | undefined) {
        super();
        // super(`configuration:${configurationName}`);
    }

    build_tree: Make | undefined;

    update(configurationName: string): void {
        this._name = configurationName;
    }

    updateTargets(build_tree: Make) : void {
        this.build_tree = build_tree;
        countStats(build_tree);
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

    constructor(configuration: string | undefined) {
        this._currentConfigurationItem = new ConfigurationNode(configuration);
    }

    private _currentConfigurationItem: ConfigurationNode;

    public refresh(): any {
        this._changeEvent.fire(this._currentConfigurationItem);
    }

    get onDidChangeTreeData(): any {
        return this._changeEvent.event;
    }
    async getTreeItem(node: Node): Promise<vscode.TreeItem> {
        return node.getTreeItem();
    }
    getChildren(node?: Node): Node[] {
        if (node) {
            //throw new Error("Unexpected request for children of ProjectOutlineProvider");
            return node.getChildren();
        }
        return [this._currentConfigurationItem];
     }
    public getParent(element: Node): Node | undefined {
        //const parent = element. resource.with({ path: dirname(element.resource.path) });
        // return parent.path !== '//' ? { resource: parent, isDirectory: true } : undefined;
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

    async update(configuration: string): Promise<void> {
        this._currentConfigurationItem.update(configuration);

        this.updateTree();
    }

    updateConfiguration(configuration: string): void {
        this._currentConfigurationItem.update(configuration);
        this.updateTree();
    }

    updateTargets(build_tree: Make) : void {
        this._currentConfigurationItem.updateTargets(build_tree);
        this.updateTree();
    }

    updateTree(): void {
        this._changeEvent.fire(null);
    }
}
