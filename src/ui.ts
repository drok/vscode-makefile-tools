// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as vscode from 'vscode';

import * as nls from 'vscode-nls';
nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize: nls.LocalizeFunc = nls.loadMessageBundle();
const recursiveString = localize("recursive", "(recursive)");

let ui: UI;

export enum UIStatus {
    OK = 0,
    WARN = 1,
    ERR = 2,
    /* Bugs like thrown exceptions */
    RUNTIME = 3,
    /* Other error conditions */
    NO_MAKEFILE = 4,
    NON_AUTOTOOLS = 5,
    /* Updating makefiles */
    REGEN = 6,
    LOADING = 7,
}

export class UI {
    private configuration: string;
    private configurationButton: vscode.StatusBarItem;
    private intree: boolean;
    static colors: vscode.ThemeColor[] = [
        new vscode.ThemeColor("statusBar.background"),
        new vscode.ThemeColor("statusBarItem.warningBackground"),
        new vscode.ThemeColor("statusBarItem.errorBackground"),
        new vscode.ThemeColor("statusBarItem.errorBackground"),
        new vscode.ThemeColor("statusBarItem.errorBackground"),
        new vscode.ThemeColor("statusBar.background"),
        new vscode.ThemeColor("statusBar.background"),
        new vscode.ThemeColor("statusBar.background"),
    ];
    static fgcolors: vscode.ThemeColor[] = [
        new vscode.ThemeColor("statusBar.foreground"), /* OK */
        new vscode.ThemeColor("statusBarItem.warningForeground"), /* WARN */
        new vscode.ThemeColor("statusBarItem.errorForeground"), /* ERR */
        new vscode.ThemeColor("statusBarItem.errorForeground"), /* RUNTIME */
        new vscode.ThemeColor("statusBarItem.errorForeground"), /* NO_MAKEFILE */
        new vscode.ThemeColor("statusBar.foreground"), /* NON_AUTOTOOLS */
        new vscode.ThemeColor("statusBar.foreground"), /* REGEN */
        new vscode.ThemeColor("statusBar.foreground"), /* LOADING */
    ];

    /* When a new configuration is set, it is shown as 'loading' */
    public setConfiguration(configuration: string, top_builddir: string): void {
        this.configuration = configuration + (!top_builddir ? " (in-tree)" : "");
        this.intree = !top_builddir;
        this.configurationButton.tooltip = !top_builddir ?
            localize("autotools.click.in-tree", "See docs for switching to out-of-tree") :
            localize("autotools.click.setconfig", "Click to select another build configuration")
        this.setLoading(UIStatus.LOADING);
    }

    public setStatus(status: UIStatus): void {
        this.configurationButton.backgroundColor = UI.colors[status];
        this.configurationButton.color = UI.fgcolors[status];
        switch (status) {
            case UIStatus.NON_AUTOTOOLS:
                this.configurationButton.tooltip = localize("autotools.report.no.autoconf", "Not an Autotools project. Click to add autotools.");
                this.configurationButton.text = '$(tools)';
                break;
            case UIStatus.NO_MAKEFILE:
                this.configurationButton.tooltip = localize("autotools.report.no.makefine", "The configuration is not initialized; There is no Makefile.");
                break;
            case UIStatus.RUNTIME:
                this.configurationButton.tooltip = localize("autotools.report.bug", "Runtime Error; please report bug.");
                this.configurationButton.text = "$(tools) $(bug)";
                break;
        }
        switch (status) {
            case UIStatus.NON_AUTOTOOLS:
                this.configurationButton.command = "autotools.addAutotools";
                break;
            default:
                this.configurationButton.command = "autotools.setBuildConfiguration";
                break;
        }
    }

    public setLoading(loading: UIStatus): void {
        switch (loading) {
            case UIStatus.NON_AUTOTOOLS:
                this.configurationButton.text = '$(tools)';
                break;
            case UIStatus.LOADING:
                this.configurationButton.text = '$(loading~spin) ' + this.configuration;
                break;
            case UIStatus.REGEN:
                this.configurationButton.text = '$(sync~spin) ' + this.configuration;
                break;
            default:
                this.configurationButton.text = '$(tools) ' + this.configuration;
                break;
        }
    }

    public constructor() {
        this.configuration = '...';
        this.intree = false;
        this.configurationButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 4.6);
        this.configurationButton.tooltip = localize("autotools.click.setconfig", "Click to select another build configuration");
        this.configurationButton.backgroundColor = UI.colors[UIStatus.OK];
        this.configurationButton.color = UI.fgcolors[UIStatus.OK];
    }

    public dispose(): void {
        this.configurationButton.dispose();
    }
    public show() { this.configurationButton.show(); }
    public hide() { this.configurationButton.hide(); }
}

export function getUI(): UI {
    if (ui === undefined) {
        ui = new UI();
    }

    return ui;
}
