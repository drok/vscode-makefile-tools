// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// TODO: support also the scenario of parsing a build log,
// to overcome some of --dry-run limitations
// (like some exceptions to the 'do not execute' rule
// or dependencies on a real build)

import * as configuration from '../configuration';
import { FolderConfig, TestEnvironment } from '../configuration';
import * as logger from '../logger';
import * as make from '../make';
import * as util from '../util';
import * as vscode from 'vscode';
import { WorkspaceFolder, DiagnosticCollection,
    workspace,
    TreeItemCollapsibleState, TreeItem, Task, TestItem,
    ThemeColor, ThemeIcon,
    Diagnostic, Location, Position, DiagnosticRelatedInformation, DiagnosticSeverity,
    Range, Uri,
    } from 'vscode';
import * as path from 'path';
import {Parser, ParserDisp, EmptyLine } from '../parser';
import { Executing } from './shell';
import { Node, Scheme } from '../tree';

import * as nls from 'vscode-nls';
import { Extension, extension, telemetry } from '../extension';
import { Span } from '@opentelemetry/api';
import { fstat } from 'fs';
import { isContext } from 'vm';
nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize: nls.LocalizeFunc = nls.loadMessageBundle();

/* https://stackoverflow.com/questions/72119570/why-doesnt-vs-code-typescript-recognize-the-indices-property-on-the-result-of-r */
export type RegExpMatchArrayWithIndices = RegExpMatchArray & { indices: Array<[number, number]> };

const chunkSize: number = 100;

enum MakeSection {
    Starting, /* pre Entering directory */
    Making, /* update target... */
    Copyright, /* # GNU make 4.1 ... */
    Database, /* --print-data-base dump */
    Padding, /* Extra output I don't care about */
}
export const EnteringRE = /^# make(?:\[\d+\])?: Entering directory '(.*)'$/;
const LeavingRE = /^# make(?:\[\d+\])?: Leaving directory '(.*)'$/;
const NothingRE = /^make(?:\[\d+\])?: Nothing to be done for '(.*)'\.$/;
export const ExecutingRE = /^(<builtin>|(.+):(\d+)): (?:update target '(.*)' due to: (?:.*)|target '(.*)' does not exist)$/;
const UptodateRE = /^make(?:\[\d+\])?: '(.*)' is up to date\.$/;
export const CopyrightRE = /^# (?:GNU Make|Mergesium Dry-Runner)/;
const RecursingRE = /^Making (.*) in (.*)$/;
/**
 * Parse the stdout of a GNU make run, and expect a Dumped database,
 * directory entry/leaving trace messages, and expanded shell fragments would
 * be run when building the targets.
 * Calls Database, Executing parser to extract info about the current makefile,
 * and Make to parse submake output.
 */
export interface MakeContext {
    allmakes: Map<string, Make>; // All directories in this tree. Used to deduplicate make runs
    parserStack: Parser[]; // Used to find make loops
    fc: FolderConfig;
    diag: Map<string, Diagnostic[]>;
    diags: DiagnosticCollection;
    /* Maps the URI for all makefiles (think blah.mak includes) where rules are read from
     * In simple cases without include, this will be a map of all 'Makefile' files.
     * Used so each Goal can store a shared reference, instead of a separate URI object
     */
    makefiles: Map<string, Uri>;
    root: string;
    span: Span;
}

export class Make implements Parser {
    public static readonly Flags = {
        None: 0,
        /* This make calls its parents */
        LoopFrom: 1,
        /* this is a make called from its submakes */
        LoopVia: 2,
    };
    constructor(public dir: string, public ctx: MakeContext, public parent: Make | undefined)
    {
        if (ctx.root) ctx.fc.buildTargets.set(this.dir, this.goals);
    }
    static makeArgs(): string[] { return [
        // take precedence over other parallel executions
        // specified in makefiles
        "-j1", "--output-sync=none",
        "--print-directory",
        // automake makefiles don't rely on builtin rules, so this makes the evaluation
        // a little faster, but the user could force custom rules which do rely on
        // builtin rules. If this is the case, the build be evaluated unexpectedly.
        // Relying on builtin rules would make the config non-portable, as it would need
        // GNU make.
        // TODO: How to tell the user his config is non-portable? Maybe allow a setting
        // "Allow non-portable config" ?
    ];};
    ingest (line: string) : [ParserDisp, Parser] {
        switch (this.section) {
            case MakeSection.Database:
                this.section = MakeSection.Padding;
                /* intentional fall-through, allows leaving immediately past Database */
            case MakeSection.Padding:
                let finished = DatabaseFinishedRE.test(line);
                if (finished) {
                    this.section = MakeSection.Making;
                    return [ParserDisp.Continue, this];
                }
            break;
            case MakeSection.Starting:
                this.section = MakeSection.Making;
                /* intentional fall-through */
            case MakeSection.Making:
                let leaving = LeavingRE.test(line);
                if (leaving) {
                    return [ParserDisp.Leave, this];
                }
                let executing = ExecutingRE.exec(line) as RegExpMatchArrayWithIndices;
                if (executing) {
//                    if (this.file == "config.status" && false) { // FIXME: implement recursive detection. a single refresh is ok if configure.ac is newer
//                        // For some reason, reconfig was triggerred, meaning
//                        // --dry-run was not respected. Abort. this is a bug.
//                        throw new Error(`Unexpected reconfig in Make ${this.dir}. This is a bug.`);
//                    }
                    this.startExecuting(executing);
                    return [ParserDisp.Enter, new Executing(this)];
                }
                let uptodate = UptodateRE.exec(line);
                if (uptodate)
                    return [ParserDisp.Continue, this];
                let nothing = NothingRE.test(line);
                if (nothing)
                    return [ParserDisp.Continue, this];
                let entering = EnteringRE.exec(line);
                if (entering) { // This should only happen once at the top of the stack
                    // this.section = MakeSection.Making;
                    // This is not a hack: make in a deeper dir could call a shallow dir.
                    // That should be a new make, because it's at a different depth/dependency path
                    return this.enter(entering[1]);
                }
                let copyright = CopyrightRE.test(line);
                if (copyright) {
                    this.section = MakeSection.Copyright;
                    return [ParserDisp.Continue, this];
                }
                break;
            case MakeSection.Copyright:
                let database = DatabaseRE.test(line);
                if (database) {
                    this.section = MakeSection.Database;
                    return [ParserDisp.Enter, new EmptyLine(new Database(this))];
                }
                break;
        }
        return [ParserDisp.Continue, this];
    }
    push(sub: Parser) : Parser | undefined {
        if (sub instanceof Database) {
            let targets = this.ctx.fc.buildTargets;
            // FIXME: GNU make enters several times the same directory during --dry-run
            // Can the work of parsing additional enterings be avoided?
            // only save data for the all-recursive target
            if (!targets.has(this.dir) || true) {
                targets.set(this.dir, sub.make.goals);
                // this.goals = sub.make.goals;
                sub.variables.some((v) => {
                    if (v.variable)
                    switch (v.variable.name) {
                        case "CONFIG_HEADER":
                            // Targets with spaces in their names are not supported
                            // because make doesn't support them, at least not without
                            // significant song and dance. If you need to support
                            // tests with spaces in their names, please send PR.
                            this.config_header = new Set(v.variable.value.split(' '));
                            return true;
                        default:
                            break;
                    }
                    return false;
                });
                /* Copy the Bin_test flag for logs that are generated by built tests
                 * and attach the built test as a depend, so it can be run under the debugger
                 */
                if (this.test_suite && this.test_suite.depends) {
                    this.test_suite.depends = this.test_suite.depends.map((d) => {
                        if (!d.goal) return d;
                        let n = this.goals.get(d.goal);
                        return n || d;
                    });
                }

                // Replace the test programs with build targets if known
                for (let g of this.goals.values()) {
                    if ((g.flags & Goal.Flags.Test_Log) && g.depends && g.depends[0].goal) {
                        let d = this.goals.get(g.depends[0].goal);
                        if (d) {
                            g.depends=[d];
                        }
                    }
                }
            }
            return this;
        } else if (sub instanceof Make) {
            if (this == sub)
                return this;
//                throw new Error(`Unexpected push in Make ${sub}`);
            if (sub.dir == this.dir) {
                logger.message(`ERROR: Unexpected make @ ${sub.dir} is a dependency of two targets: ${this.file} and ${sub.file} called from different hierarchical depths`);
                telemetry.logException(new Error(`make-multi-depth ${this.file} and ${sub.file}`), this.ctx.span);
            } else {
                this.submake.set(sub.dir, sub);
            }
            return this;
        } else if (sub instanceof Executing) {
            if (this.section == MakeSection.Copyright) {
                // Do something about the collected command lines?
                // this.section == Copyright if Executing found the copyright. Ie,
                // Executions are complete.
                return this;
            }
            return new Executing(this);
        } else if (sub instanceof EmptyLine) { return undefined; }
        throw new Error(`Unexpected push in Make ${sub}`);
    }
    enter(dir: string) : [ParserDisp, Parser] {
        let reldir = path.relative(this.ctx.root, dir);
        if (reldir.startsWith('..'))
            reldir = dir;
        if (path.isAbsolute(reldir) && !this.ctx.allmakes.has(reldir)) {
            let line = this.lastRuleLine ? this.lastRuleLine - 1 : 0;
            let diag = new Diagnostic(
                new Range(0, 0, 0, 100),
            localize("gnumake.warn.make.outside.builddir.rule", `Rule '{0}' makes outside '$builddir' in '{1}'`,
                    this.file, reldir), DiagnosticSeverity.Warning);
            diag.relatedInformation = [];

            diag.relatedInformation.push(new DiagnosticRelatedInformation(
                this.getMakefileLocation(line),
                localize("gnumake.warn.make.outside.builddir.hint",
                    `Review rule '{0}' - only one warning of this kind is shown per Makefile`,
                    this.file)
            ));

            this.addDiag(this.amPath,
                diag, 'make-outside-builddir');
        }
        let sub = this.getMake(reldir);
        if (this != sub && !(this.flags & Make.Flags.LoopFrom) && !(sub.flags & Make.Flags.LoopVia) && this.ctx.parserStack.includes(sub)) {
            this.flags |= Make.Flags.LoopFrom;
            sub.flags |= Make.Flags.LoopVia;

            let line = this.lastRuleLine ? this.lastRuleLine - 1 : 0;
            let diag = new Diagnostic(
                new Range(0, 0, 0, 100),
            localize("gnumake.warn.make.loop", `Rule '{0}' creates a make loop to '{1}'`,
                    this.file, sub.getDir()), DiagnosticSeverity.Warning);
            diag.relatedInformation = [];

            diag.relatedInformation.push(new DiagnosticRelatedInformation(
                this.getMakefileLocation(line),
                localize("gnumake.warn.make.loop.hint",
                    `Review rule '{0}'`,
                    this.file)
            ));

            this.addDiag(this.amPath,
                diag, 'circular-make');
        }
        return [ParserDisp.Enter, sub];
    }
    getMake(reldir: string) : Make {
        if (reldir == this.dir) return this;
        let m = this.ctx.allmakes.get(reldir);
        if (!m) {
            m = new Make(reldir, this.ctx, this);
            this.ctx.allmakes.set(reldir, m);
        }
        return m;
    }
    public getFile(): string | undefined {
        return this.file;
    }
    public getDir(): string {
        return path.isAbsolute(this.dir) ? this.dir : path.join(this.ctx.root, this.dir);
    }
    public finish(): void { this.section = MakeSection.Copyright; }
    public startExecuting(rea: RegExpMatchArrayWithIndices) {
        if (rea[1] === "<builtin>" && !make.builtin_targets.has(this.dir + "/" + rea[4])) {
            /* Find the targets which depend on this builtin target, and apply
             * MissingRule flag to all.
             */
            for (const [name,g] of this.goals) {
                if (g.depends?.find(i => i.goal == rea[4])) {
                    g.flags |= Goal.Flags.MissingRule;
                    if (!g.ruleMakefile || !g.ruleLine)
                        continue;
                    if (g.flags & Goal.Flags.MissingRule) {
                        let diag = new Diagnostic(
                            new Range(g.ruleLine-2, 0, g.ruleLine-2, 100),
                            localize("gnumake.warn.builtin.rule", `'{0}' relies on built-in rule to build '{1}'`,
                                g.goal, rea[4]), DiagnosticSeverity.Warning);
                            diag.relatedInformation = [];
                            let slug  = rea[4].replace(/[^[:alnum:]+]/, '_');
                            diag.relatedInformation.push(new DiagnosticRelatedInformation(
                                g.make.getAmLocation(),
                                localize("gnumake.warn.builtin.rule.hint.programs",
                                    `Add '{0}' to 'check_PROGRAMS'.`,
                                    rea[4])
                            ));
                            diag.relatedInformation.push(new DiagnosticRelatedInformation(
                                g.make.getAmLocation(),
                                localize("gnumake.warn.builtin.rule.hint.sources",
                                    `Add '{0}_SOURCES = {1}.c' and {0}_CFLAGS = ... (if needed).`,
                                    slug, rea[4])
                            ));

                        this.addDiag(path.resolve(this.getDir(), g.ruleMakefile.path),
                            diag, 'implicit-rule-use');
                    }
                }
            }
            make.builtin_targets.add(this.dir + "/" + rea[4]);
        }
        this.lastRuleLine = Number(rea[3]);
        this.file = rea[4] ?? rea[5];
    }
    public addDiag(file: string, d: Diagnostic, code: string): void {
        let diagsForFile = this.ctx.diag.get(file);
        if (!diagsForFile) {
            diagsForFile = [];
            this.ctx.diag.set(file, diagsForFile);
        }
        d.code =  { value: code, target: this.ctx.fc._kbUrlStatic.with({fragment: code})};
        diagsForFile.push(d);
        let u = Uri.file(file);
        this.ctx.diags.set(u, diagsForFile);
    }
    public getAmLocation() : Location {
        return new Location(
            Uri.file(this.amPath),
            new Position(0,0));
    }
    public getMakefileLocation(linenum: number) : Location {
        return new Location(
            Uri.file(path.resolve(this.getDir(), 'Makefile')),
            new Position(linenum,0));
    }
    public get amPath() : string {
        return path.resolve(this.ctx.fc.folder.uri.path, this.AmName);
    }
    /* Return the corresponding Makefile.am with relative dir prefix */
    public get AmName() : string {
        return this.dir ? path.join(this.dir, 'Makefile.am') : 'Makefile.am';
    }
    reportMissingTargets() : number {
        let nummissing : number = 0;
        for (const [name,goal] of this.goals) {
            if ((goal.flags & (Goal.Flags.FailedToBeUpdated | Goal.Flags.Not_a_target)) == (Goal.Flags.FailedToBeUpdated | Goal.Flags.Not_a_target)) {
                goal.ReportMissingTargets();
                nummissing++;
            }
        }
        return nummissing;
    }
    diags?: DiagnosticCollection;
    section: MakeSection = MakeSection.Starting;
    file?: string;
    lastRuleLine?: number; // make does not record rule line if the rule has no comands.
    goals: Map<string,Goal> = new Map<string, Goal>();
    seenVars: Set<string> = new Set();
    config_header: Set<string> | undefined;
    submake: Map<string, Make> = new Map();
    flags: number = Make.Flags.None;
    /* builtins set prevents the same builtin warning to be printed multiple times */
    test_suite: Goal | undefined;
    hasStats?: boolean;
    stats: {
        tests: number;
        programs: number;
        sharedlibs: number;
        testbins: number;
        subdirs: number;
        checks: number;
        missingRules: number;
    } = Make.StatsZero;
    static get StatsZero() { return {
        tests: 0,
        programs: 0,
        sharedlibs: 0,
        testbins: 0,
        subdirs: 0,
        checks: 0,
        missingRules: 0,
    };}
}

const DatabaseRE = /^# Make data base, printed on (.*)$/;
const DatabaseFinishedRE = /^# Finished Make data base on (.*)$/;
const FilesRE = /^# Files$/;
const VariablesRE = /^# Variables$/;
/**
 * Parse a GNU make database dump to extract the list of build goals (targets)
 */
export class Database implements Parser {
    // constructor() { this.goals = []; }
    constructor (public make: Make) {
    }
    static makeArgs(): string[] { return [
        "--print-data-base",
    ];};
    ingest (line: string) : [ParserDisp, Parser] {
        if (FilesRE.test(line))
            return [ParserDisp.Enter, new EmptyLine(new Goal(this.make))];
        if (VariablesRE.test(line))
            return [ParserDisp.Enter, new EmptyLine(new Variable(this.make))];
        return [ParserDisp.Continue, this];
            // throw new Error(`Unexpected line ${line}`);
    }
    push(sub: Parser) {
        if (sub instanceof Goal) {
            if (!sub.goal) { /* End-of-goals, at # files hash-table stats */
                return undefined;
            } else {

                // binaries that follow a test suite are always test programs
                // TODO: check automake source code. is this guaranteed?
//                if (this.test_suite && (sub.flags & Goal.Flags.Linked_binary))
//                    sub.flags |= Goal.Flags.Test_Program;
                return new Goal(this.make); /* look for more Goals */
            }
        } else if (sub instanceof Variable) {
            if (!sub.flags) { /* End-of-variables */
                return sub;
            } else if (sub.variable) { /* gather only variables that were
                                        * interesting enough to collect */
                this.variables.push(sub);
            }
            return new Variable(this.make);
        } else if (sub instanceof EmptyLine) { return undefined; }
        throw new Error(`Unexpected push in ${sub}`);
    }
    variables : Variable[] = [];
}

// Lines which have variable content, but I don't need them
// const VariableMakefileRe = /^# makefile \(from '(.*)', line (\d+)\)$/;
const VariableFlagsRe = /^# (makefile|environment|automatic|default|command|'override'|variable)/;
const MakefileCoordRe = /^# makefile \(from '(.*)', line (\d+)\)$/;
const VariableDefinitionRe = /^(.*) = (.*)$/;
/**
 * Parse information about a single variable, differentiating makefile,
 * environment, default (:=), command line, 'override' directives
 * and automatic variables.
 */
export class Variable implements Parser {
    public static readonly Flags = {
        None: 0,
        /* Variable maked as "makefile" */
        makefile: 1,

        /* other variables */
        other: 2,
    };
    constructor(private make: Make) {}
    static makeArgs(): string[] { return [
        // Nothing. The goals are output when the Database is output
    ];};
    ingest (line: string) : [ParserDisp, Parser] {
        if (line == "") {
            if (!this.variable)
                throw new Error("Unexpected end of variable");
            return [ParserDisp.Leave, this];
        } else {
            if (!this.flags) {
                let flags = VariableFlagsRe.exec(line);
                if (flags) {
                    switch (flags[1]) {
                        case "variable":
                            if (line == '# variable set hash-table stats:')
                                return [ParserDisp.Leave, this];
                            throw new Error(`Unexpected variable line '${line}'`);
                        case "makefile":
                            this.flags |= Variable.Flags.makefile;
                            let coord = MakefileCoordRe.exec(line);
                            if (coord) {
                                this.makefile = coord[1];
                                this.linenum = Number(coord[2]);
                            }
                            break;
                        default:
                            this.flags |= Variable.Flags.other;
                            break;
                    }
                } else
                    throw new Error(`Unexpected variable line '${line}'`);
                return [ParserDisp.Continue, this];
            }
            if (this.flags & Variable.Flags.makefile) {
                let variable = VariableDefinitionRe.exec(line);
                if (variable && !this.make.seenVars.has(variable[1])) {
                    this.make.seenVars.add(variable[1]);
                    this.variable = { name: variable[1], value: variable[2] };
                    switch (variable[1]) {
                        case "TESTS_ENVIRONMENT":
                            this.make.ctx.fc.traits.overrides_TESTS_ENVIRONMENT = true;
                            this.reportOverwrittenVariable();
                            break;
//                        case "TESTS": this.variable = { name: variable[1], value: variable[2] }; break;
                        default:
                            if (variable[1].endsWith('LOG_DRIVER')) {
                                if (!LogDriverRe.test(variable[2]))
                                    this.reportOverwrittenVariable();
                            }
                            if (variable[1] != "LOG_DRIVER") // This is overriden by default
                                this.make.ctx.fc.traits.log_drivers.add(variable[1]);
                            break;
                    }
                }
            }
        }
        return [ParserDisp.Leave, this];
    }
    reportOverwrittenVariable() : void {
        let code : string = 'overwrites-' + util.slugify(this.variable!.name);

        let diag = new Diagnostic(
            new Range(this.linenum! - 1, 0, this.linenum! - 1, 100),
            localize("gnumake.warn.overwrites.user.variable",
                `'{0}' overwrites the user variable '{1}' with '{2}'`,
                this.makefile, this.variable!.name, this.variable!.value), DiagnosticSeverity.Warning);
        this.make.addDiag(path.resolve(this.make.getDir(), this.makefile!),
            diag, code);
            telemetry.logEvent(this.make.ctx.span, code, {setVar: this.variable!.name}, true);
        }
    push(sub: Parser) {
        return undefined; /* The end of the Recipe is the end of the Goal */
    }
    variable: { name: string, value : string } | undefined;
    flags: number = Goal.Flags.None;
    makefile?: string;
    linenum?: number;
}

const GoalInfoRe = /^#  (.*)$/;
// Lines which have variable content, but I don't need them
const GoalAckInfoRe = /^(?:Implicit\/static pattern stem:|Last modified)/;
const GoalVarsRe = /^# (?:automatic|. :=|variable set hash-table stats:|Load=)/;
const AlsoMakesRe = /^Also makes: (.*)/;
const GoalFlagsRe = /^# (.*):$/;
const GoalRe = /^(.*): ?(.*)$/;
const AutomakePrimaryRe = /^(?:all|check|distcheck|install)$/;
const GNUMakeAuxiliaryRe = new RegExp('^\.(?:' +
    '(PHONY|SUFFIXES|PRECIOUS|NOEXPORT|MAKE)' +
    ')$');
/* Auxiliary goals are internally used by automake. They are dropped by the parser */
const AutomakeAuxRe = /(?:-recursive|-am|config.status|Makefile|stamp-h1|^am--.*|^\.deps\/.*|^\.DEFAULT|^\.obj|^\.c|^\.o|^\.c\.o|^\.c\.obj|^\.trs|^\.log\.trs|.*\.trs|depcomp|compile|missing|install-sh|Makefile.am)$/;
/* Noise targets are those a user most likely never wants to build from a gui */
const AutomakeNoiseRe = new RegExp('^(' +
    'ID|GTAGS|TAGS|CTAGS|tags|ctags|cscope|cscope\\.files|cscopelist|' +
    'installdirs|distcleancheck|distuninstallcheck|distdir|' +
    'mostlyclean|maintainer-clean-generic|mostlyclean-generic|clean-cscope|clean|' +
    'dist.*|uninstall-.*|install-.*|maintainer-.*|distclean-.*|installcheck|check-TESTS|' +
    'ps|html|pdf|clean-.*|info|mostlyclean|dvi|' +
    '(?:.*/)(?:\.|_)dirstamp|' +
//    '.*\\.o|.*\\.h|' +
    'Makefile.in)$');
const AutomakeTestLogRe = /^.*\.log$/;
const GoalRecipeRe = /^recipe to execute \((built-in|from '(.*)', line (\d+))\):/;
const GoalsEndRe = /^# files hash-table stats:$/;
const _empty = '';
/**
 * Parse information about a single goal, differentiating phony targets,
 * and expandable to handle other flags that Make keeps about each target
 * (eg, whether it is up-to-date). Calls the Recipe to parse the build recipe
 * if any.
 */
export class Goal extends Node implements Parser {
    public static readonly Flags = {
        None: 0,
        FullyParsed: 1,

        /* Flags gathered from Make (phony, etc) */
        FailedToBeUpdated: 2,
        BuiltIn: 4,
        Not_a_target: 8,

        /* Well-known automake targets */
        Automake_primary: 16,
        Automake_auxiliary: 32,
        Automake_noise: 64,


        /* Flags gathered from automake (recipe hints like $(LINK) */
        Dependency : 128,
        Linked_binary: 256,
        Libtool_Linked: 512,
        Test_Suite: 1024,
        Test_Program: 2048,
        Test_Log: 4096,
        SharedLib: 8192,
        MissingRule: 16384,
    };
    public trs?: make.TestResult;

    private static readonly iconColor = new ThemeColor('minimap.selectionHighlight');
    private static readonly LinkedProgramIcon = new ThemeIcon('file-binary', this.iconColor);
    private static readonly LinkedLibraryIcon = new ThemeIcon('library', this.iconColor);
    private static readonly LinkedTestIcon = new ThemeIcon('beaker', this.iconColor);
    static readonly CheckIcon = new ThemeIcon('check-all', this.iconColor);


    static makeArgs(): string[] { return [
        // Nothing. The goals are output when the Database is output
    ];};
    ingest (line: string) : [ParserDisp, Parser] {
        if (line == "") {
            if (!this.goal)
                throw new Error("Unexpected end of goal");
            this.parsingComplete();
            return [ParserDisp.Leave, this];
        } else {
            if (!this.goal) {
                let flags = GoalFlagsRe.exec(line);
                if (flags) {
                    switch (flags[1]) {
                        case "Not a target":
                            this.flags |= Goal.Flags.Not_a_target;
                            return [ParserDisp.Continue, this];
                        default:
                            if (GoalsEndRe.test(line))
                                return [ParserDisp.Leave, this];
                            throw new Error(`Unexpected Goal Flags ${flags[1]}`);
                        }
                }
            } else {
                if (this.flags & Goal.Flags.FullyParsed)
                    return [ParserDisp.Continue, this];
                let info = GoalInfoRe.exec(line);
                if (info) {
                    switch (info[1]) {
                        case "Command line target.":
                            return [ParserDisp.Continue, this];
                        case "Failed to be updated.":
                            /* FIXME: This should be handled */
                            this.flags |= Goal.Flags.FailedToBeUpdated;
                            return [ParserDisp.Continue, this];
                        case "Builtin rule":
                            /* FIXME: Should warn user of non-portable if builtins are used */
                            return [ParserDisp.Continue, this];
                        default:
                            if(GoalAckInfoRe.test(info[1]))
                                return [ParserDisp.Continue, this];

                            let recipe = GoalRecipeRe.exec(info[1]);
                            if (recipe) {
                                if (this.goal) {
                                    /* If a goal obj exists for this target, use it instead of this.
                                     */
                                    let g = this.make.goals.get(this.goal) ?? this;
                                    if (recipe[1] == 'built-in')
                                        g.flags |= Goal.Flags.BuiltIn;
                                    else {
                                        let makefile = path.resolve(this.make.getDir(), recipe[2]);
                                        this.ruleMakefile = this.make.ctx.makefiles.get(makefile);
                                        if (!this.ruleMakefile)
                                            this.make.ctx.makefiles.set(makefile, Uri.file(makefile));
                                        // FIXME: This is done more than once (repeated rules)
                                        this.ruleLine = Number(recipe[3]);
                                    }
                                    return [ParserDisp.Enter, new Recipe(g)];
                                } else
                                    throw new Error(`Unexpected Recipe in ${recipe[2]}:${recipe[3]} before goal name`);
                            }
                            let alsoTargets = AlsoMakesRe.exec(info[1]);
                            if (alsoTargets) {
                                let go = this.make.goals.get(this.goal) ?? this;
                                //assert(go.depends, "Also-makes targets should have a depends list");
                                if (!go.siblings) {
                                    go.siblings = [];
                                    alsoTargets[1].split(' ')
                                        .forEach(t => {
                                            let g = this.getGoal(t, go.flags);
                                            go.siblings!.push(g);
                                            g.depends = go.depends;
                                        });
                                }
                                return [ParserDisp.Continue, go];
                            }
                            throw new Error(`Unexpected Goal Info ${info[1]}`);
                        }
                } else {
                    if(GoalVarsRe.test(line))
                        return [ParserDisp.Continue, this];
                }
            }
            let goal = GoalRe.exec(line);
            if (goal) {
                if (this.goal)
                    throw new Error("Unexpected multiple goals per Goal section");
                if (AutomakeAuxRe.test(goal[1]) || GNUMakeAuxiliaryRe.test(goal[1]))
                    this.flags |= Goal.Flags.Automake_auxiliary;
                else if (AutomakePrimaryRe.test(goal[1]))
                    this.flags |= Goal.Flags.Automake_primary;
                else if (AutomakeNoiseRe.test(goal[1]))
                    this.flags |= Goal.Flags.Automake_noise;

                /* Record this goal on make's goal list */
                /* Don't store automake auxiliary targets, they are thus
                 * unavailable for target selection
                 * Also skip noise targets because they are marginally useful, but
                 * nothing is implemented for them.
                 * Also skip not-targets (these are source files, not targets)
                 * Also skip targets without any flags
                 */
                /* If a goal obj exists for this target, use it instead of this.
                    * If not, add it to the make's goal list
                    */
                let thiso : Goal;
                if (!this.goal) {
                    let go = this.make.goals.get(goal[1]);
                    this.goal = goal[1];
                    if (!go) {
                        // this.goal = goal[1];
                    } else if (go.flags & Goal.Flags.FullyParsed)
                        return [ParserDisp.Continue, go];// FIXME: Can return early if go already exists. avoid re-parsing depends
                    else
                        go.flags |= this.flags;
                    thiso = go ?? this;
                } else thiso = this;

                if ((!(thiso.flags & (Goal.Flags.Automake_auxiliary |
//                    Goal.Flags.Not_a_target |
                    Goal.Flags.Automake_noise
                    )) || (
                        thiso.flags & (Goal.Flags.Dependency)
                    ))
                    &&
                    /* Only worry about files inside the workspace */
                    (!path.isAbsolute(thiso.goal!) || workspace.getWorkspaceFolder(Uri.file(thiso.goal!)))
                    ) {


                    this.make.goals.set(goal[1], thiso);
                    if (goal[2]) {
                        if (thiso.goal == "test-suite.log") {
                            thiso.flags |= Goal.Flags.Test_Suite;
                            this.make.test_suite = thiso;
                            thiso.depends = goal[2].split(' ')
                                .filter(s => s && s != '|')
                                .map(s => this.getGoal(s, Goal.Flags.Test_Log));
                        } else if (AutomakeTestLogRe.test(goal[1])) {
                            thiso.flags |= Goal.Flags.Test_Log;
                            thiso.depends = goal[2].split(' ')
                                .filter(s => s != '|') // remove the marker symbol for order-only deps
                                .map(s => this.getGoal(s, Goal.Flags.Test_Program));
                        } else if (!GNUMakeAuxiliaryRe.test(goal[1]) && !AutomakeAuxRe.test(goal[1]) && !AutomakeNoiseRe.test(goal[1])) {
                            thiso.flags |= Goal.Flags.Dependency;
                            thiso.depends = goal[2].split(' ')
                                .filter(s => s && s != '|' && // remove the marker symbol for order-only deps
                                    !AutomakeNoiseRe.test(s) &&
                                    !AutomakeAuxRe.test(s) &&
                                        (!path.isAbsolute(s) || // This includes builddir files (relative)
                                            workspace.getWorkspaceFolder(Uri.file(s))))
                                // MUST filter on workspace|builddir files. This list contains /usr/include files
                                .map(s => this.getGoal(s, Goal.Flags.Dependency));
                        }
                    } else if (!thiso.flags) {
                        // .test.log: (ie, implicit rules)
                        thiso.flags |= Goal.Flags.Automake_noise;
                    }
                }
                return [ParserDisp.Continue, thiso];
            }
        }
        throw new Error(`Unexpected Goal line ${line}`);
    }
    parsingComplete() {
        if (this.flags & Goal.Flags.FullyParsed) // shorcut due to repeated runs
            return;

        this.flags |= Goal.Flags.FullyParsed;
    }
    ReportMissingTargets() : void {
        let code = 'missing-rule';
        for (const [name,g] of this.make.goals) {
            if (g.depends?.includes(this)) {
                let diag = new Diagnostic(
                    new Range(0, 0, 0, 100),
                    localize("gnumake.warn.missing.rule",
                        `No rule to make '{0}', needed by '{1}'`,
                        this.goal, name), DiagnosticSeverity.Error);
                /* The make dir where the dependency with missing rule is made */
                let libMake = this.make.ctx.allmakes.get(path.normalize(path.join(this.make.dir, path.dirname(this.goal!))));
                diag.relatedInformation = [];
                if (libMake) {
                    let goalLocation = g.make.getAmLocation();
                    diag.relatedInformation.push(new DiagnosticRelatedInformation(
                        goalLocation,
                        localize("gnumake.warn.missing.rule.hint.refactor",
                            `This can be avoided by moving the rules for inter-dependent targets {0} and {1} into the same Makefile.`,
                            this.goal, g.goal)
                    ));
                    diag.relatedInformation.push(new DiagnosticRelatedInformation(
                        goalLocation,
                        localize("gnumake.warn.missing.rule.hint.refactor",
                            `Example: Refactor '{0}' to include '{1}' so the '{2}' and '{3}' rules are in the same location.`,
                            this.make.AmName, libMake.AmName,
                            this.goal, g.goal)
                    ));
                    if (libMake.parent) {
                        diag.relatedInformation.push(new DiagnosticRelatedInformation(
                            libMake.parent.getAmLocation(),
                            localize("gnumake.warn.missing.rule.hint.rmsubdir",
                                `Remove '{0}' from SUBDIRS in the caller, '{1}'.`,
                                libMake.dir, libMake.parent.AmName)
                        ));
                    }
                    let acline = this.make.ctx.fc.pkginfo?.ac_config_files_line ? this.make.ctx.fc.pkginfo?.ac_config_files_line - 1 : 0;
                    let acLocation = new Location(Uri.file(path.resolve(this.make.ctx.fc.folder.uri.path, this.make.ctx.fc.configureAc || 'configure.ac')),
                        new Position(acline,0));
                    diag.relatedInformation.push(new DiagnosticRelatedInformation(
                        acLocation,
                        localize("gnumake.warn.missing.rule.hint.rm.ac_config_files",
                            `Remove '{0}/Makefile' from AC_CONFIG_FILES.`,
                            libMake.dir)
                    ));
                    let line = g.ruleLine ? g.ruleLine - 2 : 0;
                    diag.relatedInformation.push(new DiagnosticRelatedInformation(
                        g.make.getMakefileLocation(line),
                        localize("gnumake.warn.missing.rule.hint.makefile",
                            `Jump to rule '{0}'`,
                            name)
                    ));
                }

                this.make.addDiag(g.make.amPath, diag, code);
            }
        }
    }
    getGoal(s: string, flags: number = Goal.Flags.None) : Goal {
        let norms = path.normalize(s);
        let known = this.make.goals.get(norms);
        if (!known) {
            let newGoal = new Goal(this.make, norms, flags);
            this.make.goals.set(norms, newGoal);
            return newGoal;
        }
        known.flags |= flags;
        return known;
    }
    push(sub: Parser) {
        return undefined; /* The end of the Recipe is the end of the Goal */
    }
    getChildren(): Node[] {
        if ((this.flags & Goal.Flags.Test_Suite)) {
            return this.depends ?? []
        }
        else
            return [];
    }
    getTreeItem(state: TreeItemCollapsibleState, provider?: vscode.TreeDataProvider<Node>): TreeItem {
        if (!this.goal)
            throw new Error("Unexpected null goal");
        let item = new TreeItem(this.goal);
        item.collapsibleState = state;
        item.tooltip = this.goal;
//        item.contextValue = ["nodeType=task"]
//            .concat((this.flags & Goal.Flags.Linked_binary) ? ['nodeType=build'] : [])
//            .concat((this.flags & Goal.Flags.Test_Log) ? ['nodeType=test'] : [])
//            .concat((this.flags & Goal.Flags.Test_Log) &&
//                (this.depends && (this.depends[0].flags & Goal.Flags.Linked_binary)) ? ['nodeType=bintest'] : [])
//            .join(',');
        if (!this.task)
            return item;

        if (this.flags & Goal.Flags.Test_Log) {
            item.contextValue = (this.depends && (this.depends[0].flags & Goal.Flags.Linked_binary)) ?
                'nodeType=task,nodeType=test,nodeType=bintest' :
                'nodeType=task,nodeType=test';
            item.resourceUri = this.getURI();
            extension._projectTestSuitesProvider.all.set(item.resourceUri.path, this);
            item.iconPath = Goal.LinkedTestIcon;
            // item.id = this.getFilePath();
        } else
        if (this.flags & Goal.Flags.Test_Suite) {
            item.description = this.make.stats.tests ?
                localize("autotools.subnode.suite", "{0} tests", this.make.stats.tests) : undefined;
            item.tooltip =  this.make.dir;
            // must satisfy the isURI test otherwise it is reallocated and the refernce won't
            // match in privideFileDecoration.
            // test is at https://github.com/microsoft/vscode/blob/main/src/vs/base/common/uri.ts#L98
            item.resourceUri = this.getURI();
        } else
        if (this.flags & Goal.Flags.Linked_binary) {
            item.iconPath = (this.flags & Goal.Flags.SharedLib) ? Goal.LinkedLibraryIcon :
            (this.flags & Goal.Flags.Test_Program) ? Goal.LinkedTestIcon : Goal.LinkedProgramIcon;
            item.resourceUri = this.getURI();
            extension._projectOutlineProvider.all.set(item.resourceUri.path, this);
            item.contextValue = 'nodeType=task,nodeType=build';
            // item.id = this.getFilePath();
        }
        item.id = item.resourceUri?.path || this.getFilePath();
        return item;
    }
    getURI() : Uri {
        if (this.flags & (Goal.Flags.Test_Suite | Goal.Flags.Test_Log))
            return Uri.from({
                scheme: (this.flags & Goal.Flags.Test_Suite) ? Scheme.Check : Scheme.Test,
                authority: _empty,//Extension.whoami,
                fragment: _empty,
                path: this.getURIPath()
            });
        else if (this.flags & (Goal.Flags.Linked_binary))
            return Uri.from({
                scheme: Scheme.Bin,
                authority: _empty,//Extension.whoami,
                fragment: _empty,
                path: this.getURIPath()
            });
        else
            return Uri.from({
                scheme: "file",
                authority: _empty,//Extension.whoami,
                fragment: _empty,
                path: this.getURIPath()
            });
    }
    getFilePath() : string {
        return path.isAbsolute(this.goal!) ?
            this.goal! :
            // Source files have no dependencies. resolve them in the source tree
            this.depends == undefined ? path.join(this.make.ctx.fc.folder.uri.path, path.normalize(path.join(this.make.dir,this.goal!))) :
            // Normalize because goals in the srcdir are refered to as /proj/src/blah/../file.c
            // when building in src/blah with source ${top_srcdir}/file.c (ie, "../file.c")
            path.normalize(path.join(this.make.ctx.root, this.make.dir,this.goal!));
    }
    getURIPath() : string {
        return path.isAbsolute(this.goal!) ?
            this.goal! :
            (this.flags & (Goal.Flags.Test_Suite | Goal.Flags.Test_Log)) ?
            path.join(this.make.ctx.fc.buildEnvPath,this.make.dir,this.goal!) :
            // Normalize because goals in the srcdir are refered to as /proj/src/blah/../file.c
            // when building in src/blah with source ${top_srcdir}/file.c (ie, "../file.c")
            path.normalize(path.join(this.make.ctx.root, this.make.dir,this.goal!));
    }

    logfile(): string | undefined {
        return path.join(this.make.dir, this.goal!);
    }

    constructor(public make: Make, public goal: string | undefined = undefined,
        public flags: number = Goal.Flags.None) {
        super();
        /* TODO: Implement check-local suite (eg, gnumake)
        if (goal == 'check-local')
            traits.has_local_suite = true;
        */
    }
    depends: Goal[] | undefined = undefined;
    livetask: Map<TestEnvironment,Task> | undefined;
    task: Task | Map<TestEnvironment,Task> | undefined;
    test: TestItem | undefined;
    siblings?: Goal[]; // "Also makes" products of the same recipe.
    ruleMakefile?: Uri;
    ruleLine?: number;
}

const LinkerRe = /\$\(\w*LINK\)\s/;
const RanlibRe = /\$\(RANLIB\)\s/;
const TestRe = /\$\(AM_TESTS_FD_REDIRECT\)\s/;
const LogDriverRe = /\$\(SHELL\) \$\(top_srcdir\)\/(?:.*)?test-driver/;
const SharedLibRe = /\.(?:|la|so|dll)$/;
/**
 * Parse an unexpanded build recipe for a target.
 * Currently no information is captured, but it could be used to learn
 * what kind of target it is (eg, if `@ref $(LINK)` or `$(COMPILE)` is referenced
 */
export class Recipe implements Parser {
    constructor(private goal: Goal) { }
    static makeArgs(): string[] { return [
        // Nothing. The goals are output when the Database is output
    ];};
    ingest (line: string) : [ParserDisp, Parser] {
        if (line == "") {
            this.goal.parsingComplete()
            return [ParserDisp.Leave, this];
        }
        if (LinkerRe.test(line)) {
            this.goal.flags |= Goal.Flags.Linked_binary;
            if (SharedLibRe.test(this.goal.goal||''))
                this.goal.flags |= Goal.Flags.SharedLib;
            // Also apply to goal.siblings ?
        }
        if (TestRe.test(line))
            this.goal.flags |= Goal.Flags.Test_Log;
            // Also apply to goal.siblings ?
        return [ParserDisp.Continue, this];
    }
    push(sub: Parser) { return undefined;}
}
export function countStats(sub: Make): number[] {
    if (sub.hasStats)
        return [
            sub.stats.programs,
            sub.stats.sharedlibs,
            sub.stats.tests,
            sub.stats.testbins,
            sub.stats.subdirs, // NOTE different than return below
            sub.stats.checks
        ];
    sub.stats.subdirs = sub.submake.size;
    sub.hasStats = true;
    for (let submake of sub.submake.values()) {
        if (sub === submake) {
            throw new Error(`Loop in countStats @ ${sub.dir}`);
        }
        let [t, sl, n, tp, s, c] = countStats(submake);
        sub.stats.programs += t;
        sub.stats.sharedlibs += sl;
        sub.stats.tests += n;
        sub.stats.testbins += tp;
        sub.stats.subdirs += s;
        sub.stats.checks += c;
    }
    for (let [goal, g] of sub.goals) {
        sub.stats.programs += ((g.flags & Goal.Flags.Linked_binary)
            && !(g.flags & (Goal.Flags.Test_Program | Goal.Flags.SharedLib))) ? 1 : 0;
        sub.stats.sharedlibs += (g.flags & Goal.Flags.SharedLib) ? 1 : 0;
        sub.stats.testbins += (g.flags & (Goal.Flags.Test_Program | Goal.Flags.Linked_binary)) == (Goal.Flags.Test_Program | Goal.Flags.Linked_binary) ? 1 : 0;
    }

    let numTestsHere = (sub.goals.get("test-suite.log")?.depends?.length ?? 0);
    sub.stats.tests += numTestsHere;
    sub.stats.checks += (numTestsHere ? 1 : 0);
    return [
        sub.stats.programs,
        sub.stats.sharedlibs,
        sub.stats.tests,
        sub.stats.testbins,
        sub.submake.size,
        sub.stats.checks
    ];
}

