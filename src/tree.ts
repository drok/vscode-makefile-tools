// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// Tree.ts

import * as configuration from './configuration';
import * as path from 'path';
import * as util from './util';
import { BuildTarget, t_none } from './make';
import { Make, Goal } from './parser/gnumake';
import * as vscode from 'vscode';

import * as nls from 'vscode-nls';
import { extension } from './extension';
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
}

export class SubNode extends Node {
    constructor(public submake: Make, private flags: number) {
        super();
    }

    getChildren(): Node[] {
        let goals : Node[] = this.submake.goals
            .filter(goal => goal.flags & this.flags)
            .map(goal => new TaskNode(goal));
        goals.push(...this.submake.submake
            .map(sub => new SubNode(sub, this.flags)));
        if ((this.flags & Goal.Flags.Test_Log) && this.submake.test_suite?.depends)
            goals.push(...this.submake.test_suite.depends
                    .map(test => new TaskNode(test)));
        return goals;
    }

    getTreeItem(): vscode.TreeItem {
        //if (!this.submake.)
        //    throw new Error("Unexpected null goal");
        const item: vscode.TreeItem = new vscode.TreeItem('dir: ' + this.submake.dir);
        item.collapsibleState = this.submake.submake.length || this.submake.goals.length ?
            vscode.TreeItemCollapsibleState.Collapsed :
            vscode.TreeItemCollapsibleState.None;
        item.tooltip = localize("makefile.target.currently.selected.for.build", "The target currently selected for build.");
        item.contextValue = ["nodeType=sub"]
            .concat((this.submake.test_suite) ? ['nodeType=check'] : [])
            .concat((this.flags & Goal.Flags.Linked_binary) ? ['nodeType=build'] : [])
            .join(',');
        return item;
    }
    makefile() : string {
        if (this.submake.dir)
            // If a relative directory, make it absolute wrt. root of workspace
            path.join('', path.join(this.submake.dir, 'Makefile.am'));
        return path.join(this.submake.dir, 'Makefile.am');
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
        const item: vscode.TreeItem = new vscode.TreeItem('node: ' + this.goal.goal);
        item.collapsibleState = vscode.TreeItemCollapsibleState.None;
        item.tooltip = localize("makefile.target.currently.selected.for.build", "The target currently selected for build.");
        item.contextValue = ["nodeType=task"]
            .concat((this.goal.flags & Goal.Flags.Linked_binary) ? ['nodeType=build'] : [])
//            .concat((this.goal.flags & Goal.Flags.Test_Progam) ? ['nodeType=test'] : [])
            .concat((this.goal.flags & Goal.Flags.Test_Log) ? ['nodeType=test'] : [])
            .join(',');
        return item;
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
        let goals : Node[] = this.tree.goals
            .filter(goal => goal.flags & this.flag)
            .map(goal => new TaskNode(goal));
        goals.push(...this.tree.submake
            .map(sub => new SubNode(sub, this.flag)));
        return goals;
    }

    getTreeItem(): vscode.TreeItem {
        const item: vscode.TreeItem = new vscode.TreeItem(this._name);
        item.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
        // item.tooltip = localize("makefile.target.currently.selected.for.build", "The target currently selected for build.");
        item.contextValue = [
            `nodeType=section.` + this._name,
        ].join(',');
        return item;
    }
}

export class CheckNode extends Node {
    constructor(targetName: BuildTarget) {
        super();
        this._name = targetName.goal;
    }

    _name: string;

    update(targetName: BuildTarget): void {
        this._name = localize("tree.check.target", "Check target: {0}", `[${targetName.goal} @ ${targetName.builddir}]`);
    }

    getChildren(): Node[] {
        return [];
    }

    getTreeItem(): vscode.TreeItem {
        const item: vscode.TreeItem = new vscode.TreeItem(this._name);
        item.collapsibleState = vscode.TreeItemCollapsibleState.None;
        item.tooltip = localize("makefile.target.currently.selected.for.build", "The target currently selected for build.");
        item.contextValue = [
            `nodeType=buildTarget`,
        ].join(',');
        return item;
    }
}

export class ConfigurationNode extends Node {
    constructor(configurationName: string) {
        super();
        // super(`configuration:${configurationName}`);
        this._name = configurationName;
    }

    _name: string;
    build_tree: Make | undefined;

    update(configurationName: string): void {
        this._name = localize("tree.configuration", "Configuration: {0}", `[${configurationName}]`);
    }

    updateTargets(build_tree: Make) : void {
        this.build_tree = build_tree;
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
            new TaskSection(this.build_tree, 'Test Suites', Goal.Flags.Test_Log),
        ];
        //return children;
    }
    public getParent(element: Node): Node | undefined {
        //const parent = element. resource.with({ path: dirname(element.resource.path) });
        // return parent.path !== '//' ? { resource: parent, isDirectory: true } : undefined;
        return {} as Node;
    }

    getTreeItem(): vscode.TreeItem {
        const item: vscode.TreeItem = new vscode.TreeItem(this._name);
        item.collapsibleState = this.build_tree ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None;
        item.tooltip = "The makefile configuration currently selected from settings ('autotools.configurations').";
        item.contextValue = [
            `nodeType=configuration`,
        ].join(',');
        return item;
    }

}

export class ProjectOutlineProvider implements vscode.TreeDataProvider<Node> {
    private readonly _changeEvent = new vscode.EventEmitter<Node | null>();
    //private readonly _unsetString = localize("Unset", "Unset");

    constructor(configuration: string) {
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
