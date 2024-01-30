
import { Disposable, TextDocumentContentProvider, Uri, Event, EventEmitter, window, workspace, TextDocumentShowOptions } from 'vscode';
import { CancellationToken } from 'vscode-jsonrpc';
import { Goal } from './parser/gnumake';
import { TestEnvironment, getAllBuildTargets, getCurrentMakefileConfiguration,
    MakefileConfiguration,
    getTestEnvironments } from './configuration';
import { TRS, TRS_Info } from './make';
import { extension, waitActivated } from './extension';
import { slugify } from './util';
import * as path from 'path';


export let GridShowOptions : TextDocumentShowOptions = {
    preview: false,
    preserveFocus: true
};

export class TestGrid implements TextDocumentContentProvider {
    private _onDidChange = new EventEmitter<Uri>();
    public readonly onDidChange: Event<Uri> = this._onDidChange.event;
    static readonly scheme = 'trs';
    static readonly top = '/Test Results';

    constructor() {

    }

    private disposables: Map<Uri, Disposable[]> = new Map();
    async provideTextDocumentContent(uri: Uri, cancel: CancellationToken): Promise<string> {
        //let goals = getAllBuildTargets();
        let c = getCurrentMakefileConfiguration();
        //let g = goals
        //    .get(path.dirname(uri.path.substring(1)))
        //    ?.get("test-suite.log");

        await waitActivated();
        // Logic to generate markdown content based on the type of document
        let has_disp : Disposable[] | undefined = this.disposables.get(uri);
        let disp : Disposable[] = has_disp || [];
        if (!has_disp) this.disposables.set(uri, disp);
        if (uri.path == TestGrid.top) {
            return this.generateTestSuiteContent(uri, disp);
        } else {
            return this.generateDetailedTestContent(uri, disp);
        }
    }
    public closeDocument(uri: Uri) {
        let has_disp : Disposable[] | undefined = this.disposables.get(uri);
        // if (has_disp) {
        //     has_disp.forEach(d => d.dispose());
        //     this.disposables.delete(uri.path);
        // }
    }
    public dispose() {
        this.disposables.forEach((d,k) => d.forEach(d => d.dispose()));
        this.disposables.clear();
    }

    configurationOutput(c: MakefileConfiguration) : string{
        let text : string = '';
        if (c.configureArgs?.length)
            text = '  * `' + c.configureArgs.join('`\n  * `') + '`\n';
        else
            text = 'default (ie, configured with `configure` and no arguments)\n'

        return `<details><summary>Build Configuration - ${c.name}</summary>

## Build Configuration - ${c.name}

${text}
</details>
`;
    }
    environmentsOutput(e: TestEnvironment[]) : string {

        return e.map<string>(i => `### **${i.name}** environment

|Variable|Value|
|:---|:---|
` +
            (i.testDebugEnv ? Object.entries(i.testDebugEnv).map<string>(
                ([k,v],n) => `|\`${k}\`|\`${v}\`|`).join('\n') : ''
            ))
            .join('\n\n');
    }
    tabulateSuite(g: Goal, dir: string) : string {
        let text : string = '';
        if (g?.depends) {
            let envs = getTestEnvironments()
            .filter(e => !e.dirs || e.dirs.includes(dir));
            text += `### ${dir}\n\n`;
            text += '|Test|' + envs.map(e => `[${e.name}](#${slugify(e.name + '-environment')})`).join('|') + '|\n';
            text += '|:---|' + ':---:|'.repeat(envs.length) + '\n';

            for (let t of g.depends) {
                let row : string[] = [];
                row.push(t.goal ?? '?');
                for (const e of envs) {
                    row.push(TRS_Info[t.trs?.results.get(e.hashCode) ?? TRS.NONE].badge ?? 'n/a');
                }
                text = text.concat('|' + row.join('|') + '|\n');
            }
            text += '\n';
        }
        return text;

    }
    generateTestSuiteContent(uri: Uri, disp: Disposable[]): Thenable<string> {
        // Generate markdown content for test suite results document
        let goals = getAllBuildTargets();
        let c = getCurrentMakefileConfiguration();

        let testResults : string = '';

        goals.forEach((goals, dir) => {
            for (let g of goals.values()) {
                if (g.flags & (Goal.Flags.Test_Suite))
                    testResults += this.tabulateSuite(g, dir);
            }

        });

        return Promise.resolve(`# Test Summary for ${extension.pkginfo?.name} ${extension.pkginfo?.version} - ${c.name}\n\n
## Test Results

${testResults}

${this.configurationOutput(c)}
<details><summary>Test Environments</summary>

## Test Environments

${this.environmentsOutput(getTestEnvironments())}
</details>
`);
    }

    generateDetailedTestContent(uri: Uri, disp: Disposable[]): Thenable<string> {
        let goals = getAllBuildTargets();
        let c = getCurrentMakefileConfiguration();
        let suiteName : string = uri.path.substring(1);
        let g = goals
            .get(suiteName)
            ?.get("test-suite.log");
    
        // Generate markdown content for detailed test result document
        if (g && (g.flags & (Goal.Flags.Test_Suite))) {
            let testResults : string = `# Test Suite ${suiteName} for ${extension.pkginfo?.name} ${extension.pkginfo?.version} - ${c.name}\n\n`;

            testResults += this.tabulateSuite(g, suiteName);

            return Promise.resolve(`# Test Suite **${suiteName}** for ${extension.pkginfo?.name} ${extension.pkginfo?.version} - ${c.name}\n\n
## Test Results

${testResults}

${this.configurationOutput(c)}
<details><summary>Test Environments</summary>

## Test Environments

${this.environmentsOutput(getTestEnvironments().filter(i => !i.dirs || i.dirs.includes(suiteName)))}
</details>
`);
        }

        return Promise.reject(new Error("Test Suite not found"));
    }

    private update(uri: Uri) {
        this._onDidChange.fire(uri);
    }
    public updateAll() {
        // FIXME: This is a hack. Should be deleted
        // updates should be granular, each finished test run should
        // update only the affected docs.
        this.disposables.forEach((d,k) => this.update(k));
    }
}