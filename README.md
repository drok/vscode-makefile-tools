# VS Code Autotools Integration

This extension enables VS Code to interact with projects using the GNU Autotools build system:
 * Manage multiple [build configurations](#build-configuration) per source-tree (out-of-tree builds)
 * Building-related functions:
    * Import build configuration into [Intellisense](#importing-intellisense-config), enabling _accurate syntax highlighting and completions_.
    * [_Generate a build task_](#generate-build-tasks) for every buildable program or library.
    * Build any single target (program, library), or all with _keybinds_.
    * [_Navigate build errors/warnings_](#navigating-compile-problems) using built-in problem matchers.
 * Testing-related functions:
    * [Import test suites](#importing-test-suites) into VS Code's **Testing UI**.
    * _Run_ single tests or full test suites using the Testing UI.
    * Support all automake test results (PASS ✔️, FAIL ❌, XPASS ☑️, XFAIL 🏳️, SKIP 🔳, ERROR 💣️, and n/a ❔)
    * Debug individual tests, [_auto-configuring_ the debugger](#debugging-tests).
    * _Live-testing_ / Test-driven development.
    * [_Generate a test task_](#generated-test-tasks) for every individual test.
    * Manage multiple [test environments](#test-environments).
    * Output _test result grid_ (build configuration vs test vs environment) in markdown format.

<figure id="figure-1">
    <img src="https://autotools.mergesium.com/s/autotools-intro.png"
         alt="Sample extension UI">
    <figcaption>Figure 1 - Sample UI in VS Code</figcaption>
</figure>

## Getting started

An autotools project has the following basic stages: boostrapping, configuration, build, test.

<figure id="figure-2">
    <img src="https://devmanual.gentoo.org/general-concepts/autotools/diagram.png"
         alt="A basic overview of main autotools">
    <figcaption>Figure 2 - <a href="https://devmanual.gentoo.org/general-concepts/autotools/index.html">A basic overview of main autotools</a> by <a href="https://www.gentoo.org/inside-gentoo/contact/">Gentoo Authors</a> licensed under <a href="https://creativecommons.org/licenses/by-sa/3.0/">CC BY-SA 3.0</a></figcaption>
</figure>

Basic familiarity with autotools projects is implied.

The primary pallette commands are:
 1. "Autotools: Bootstrap" - this is automatic when needed
 2. "Autotools: Configure" - creates the Default configuration in the subdir `build/Default`
 3. "Autotools: Build All" - runs `make all` in the build directory
 4. "Autotools: Run all tests (make check)" - builds, then runs all default tests

<figure id="figure-3">
    <img src="https://autotools.mergesium.com/s/autotools-palette.png"
         alt="Sample command palette">
    <figcaption>Figure 3 - Command palette</figcaption>
</figure>

### Bootstrapping, out-of-tree vs in-tree build configurations

When editing an autotools project for the first time, the extension will offer to bootstrap it if necessary; bootstrapping can also be done manually from the command palette using the "Autotools: Bootstrap" command. Auto-bootstrapping is controlled by the setting `autotools.autoBootstrap` (default = true)

Bootstrapping creates the `configure` script from the `configure.ac` manifest, typically by running an included `bootstrap.sh`, `autogen.sh` or the command `autoreconf -fvi`. Some projects have other bootstrapping requirements; see their respective documentation for details.

Once bootstrapped, configurations can be created using the palette using "Autotools: Create new configuration" command. This opens the workspace JSON settings, where configurations can be added as follows:

```json
    "autotools.configurations": [
        {
            "name": "Debug",
            "top_builddir": "/tmp/myproj/Debug",
        },
        {
            "name": "Release",
            "top_builddir": "build/Release",
            "configureArgs": [
                "--disable-debug",
                "CFLAGS=-Wall -Werror",
                "CC=gcc-8"
            ]
        },
```

The `name` attribute appears in the vscode UI wherever the current configuration is displayed.

The `configureArgs` is the list of configuration options given to the `configure` script. The Release configuration above represents the following build sequence:

```shell
mkdir -p build/Release &&
cd build/Release &&
../../configure --disable-debug "CFLAGS=-Wall -Werror" CC=gcc-8 &&
make all
```

`top_builddir` is the top build directory where the build configuration is created; this is where the Makefiles and object files will be stored, and where `make` will be run. It can be a relative (to the source directory) or an absolute path. This is known as an out-of-tree build; the source directory is kept clean, and the temporary object files are created in a separate directory.

If no configurations exist, a "Default" configuration is assumed, with `top_builddir` set to `build/Default`.

GNU Autotools support out-of-tree builds by default. Nothing needs to be done, other than correct use of the `$top_builddir`, `$top_srcdir`, `$builddir` and `$srcdir`. Some projects incorrectly use these predefined variables, breaking their ability to be built out-of-tree. In this case, a single configuration can be supported, aka "in-tree", which mixes source and object files. This is the same as setting `top_builddir` to ".":

```json
    "autotools.configurations": [
        {
            "name": "Default",
            "top_builddir": ".",
        }
```

Here is a typical project set up for out-of-tree building:
<figure id="figure-4">
    <img src="https://i.stack.imgur.com/x5Rbm.png"
         alt="Example of out-of-tree build">
    <figcaption>Figure 4 - <a href="https://stackoverflow.com/questions/39015453/building-c-program-out-of-source-tree-with-gnu-make">Out-of-tree build hierarchy</a> by <a href="https://stackoverflow.com/users/6178507/k-mulier">K.Mulier</a> licensed under <a href="https://creativecommons.org/licenses/by-sa/3.0/">CC BY-SA 3.0</a></figcaption>
</figure>


**Note** If no configurations are found in the workspace settings, **and** the project is already configured **in-tree**, the extension will work correctly, but it won't be possible to create alternate configurations. You can remove the in-tree configuration by running `make disclean`, which will then allow multiple out-of-tree configurations to be created.

### Configuration

Configuration creates Makefiles that implement the recipes/compiler invocations needed to compile the project. They are created from the `Makefile.am` templates, combined with the configuration items detected by the configure script (eg, pre-processor defines, include paths, dependency paths, conditional build instructions). Makefiles in an autotools project are text files, but are for all intents and purposes, object files, which should not be editted.

The extension automatically runs the configure script whenever the relevant `configureArgs` setting changes, and whenever a new configuration is created.

The Makefiles are also automatically updated if the source tree is versioned (eg, with git) and it is switched to a different branch.

It should not be necesary to manually configure a build directory, other than changing the `configureArgs` when needed. A manual configuration can be started with the pallette command "Autotools: Configure"

The palette command "Autotools: Update Makefiles and Headers" can be used to re-generate the Makefiles and configuration header files if they've been manually editted. This will revert them to the auto-generated state. It is equivalent to running `config.status`

### Building

Building runs the command `make all` in the configuration's `top_builddir` directory. Typically this compiles all installable programs and shared libraries.

It is possible to add extra arguments to the make command line using the `makeArgs` variable for the configuration. This should be used only for arguments that change how make behaves (eg, `--jobs=X`, `--load-average=Y` or `--silent`), but not for arguments that change what make does (eg, overriding the configuration or actions like `--touch` or `--question` or `--file=xxx`). Overriding the actions or configuration would cause the configuration imported to Intellisense to be different from that used to build; the syntax highlights and completions would not correspond to the build.

<figure id="figure-5">
    <img src="https://autotools.mergesium.com/s/autotools-run-tasks.png"
         alt="Sample autogenerated tasks">
    <figcaption>Figure 5 - Auto generated tasks</figcaption>
</figure>


### Testing

Testing runs the command `make check` in the `top_builddir` directory. Typically this runs the subset of available test suites that the maintainer deemed useful for users of the package to run. Usually this means a battery of integration tests intended to run at distribution/packaging time to ensure the package was built correctly. It might not include detailed unit tests or comprehensive interoperation tests. See the package documentation for detail on what test modes are available. They might be enabled with a `configure` option such as `--enable-extended-tests`

The tests included in `make check` are added to the test suite.

<figure id="figure-6">
    <img src="https://autotools.mergesium.com/s/autotools-testing-ui.png"
         alt="Sample Testing UI">
    <figcaption>Figure 6 - Testing UI</figcaption>
</figure>

The available tests are displayed in both the Testing panel and the Autotools panel, with slightly different controls and status (eg, XPASS and XFAIL results, Live-testing, link to KB), as the built-in Testing UI is not able to fully support autotools's test features.

## Build Configuration
A build configuration is the set of arguments given to the autotools `configure` script, which determine what features are compiled (eg, "`--enable-debug`"), which dependencies to use when multiple are available (eg, "`--with-ssl=libressl`"), cross-compilation options (eg, "`--host=x86_64-w64-mingw32`"), distro-specific options (eg, "`CFLAGS=-fPIE -D_FORTIFY_SOURCE=2`"), compiler selection (eg, "`CXX=g++-12`")

A project can have one or more build configurations, each in a separate directory. The built-in capability of autotools to configure a project out-of-tree is leveraged.

Contributed commands:
 * `autotools.buildAllConfigurations` ("Autotools: Build all configurations" in the palette) can be used to launch multiple builds with one configuratble keyboard shortcut.
 * `autotools.buildAll` ("Autotools: Build all" in the palette) can be used to "make all" for one selected configuration.

## Build-related features

### Importing Intellisense config
The extension extracts the exact compilation arguments for each source code file and relays these arguments to Intellisense. In turn, Intellisense builds and maintains a database of indentifiers which is used to drive syntax highlighting and also code completion.

When selecting a different build configuration, Intellisense is re-configured to reflect it, so that the syntax highlighting seen in the editor accurately corresponds to the `configureArgs` of the selected build configuration ("What You See Is What You Build"?)

The extension eliminates the need to manually configure intellisense with include paths, compiler version/flavour, C/C++ standard applicable, or defines.

### Generate build tasks

Each target that can be built, be it a program or a shared library, is associated with an automatically generated build task, which appears in the Command Pallette under the "Run Task..."/"Build Tasks" menu. This enables:
  * shortening build time by only compiling a program of interest (eg, `make oneprogram` as opposed to `make all`)
  * creating [Compound Tasks](https://code.visualstudio.com/docs/editor/tasks#_compound-tasks)
  * manually building individual targets if needed, possibly with a keyboard shortcut
  * customizing the build recipe for a single program, such as overriding compile flags (eg, `make myprogram CFLAGS-Wall`)

In very large projects, it may be beneficial to focus on a small part of a project, and the build task allow you to surgically control the build, without resorting to running 'make ...' in a terminal.

### Navigating compile problems

Building the project using the auto-generated build tasks allows compilation warnings and errors to be captured, and the offending line of source code to be located and opened with a single click in the "Problems" panel. This powerful built-in feature of vscode would not be available if the project were built by running make in a terminal window.

## Testing features

The extension implements automake's standard parallel test suite infrastructure interface. If your project follows the automake documentation on writing and running tests, they are seamlessly discovered and used directly from vscode.

### Importing test suites

The extension allows vscode's built-in Testing UI to discover test suites declared with the autotools testing infrastructure (ie, declared with the `TESTS` variable in `Makefile.am`, documented [here](https://www.gnu.org/software/automake/manual/html_node/Tests.html) and [here](https://www.gnu.org/software/automake/manual/html_node/Parallel-Test-Harness.html)).

The extension reads the test results generated by automake's test infrastructure and populates the Testing UI, such that the UI always displays an up-to-date view of latest results. Using filesystem watchers the extension is able to update the UI as tests run.

Also see the related vscode documentation on [Python testing](https://code.visualstudio.com/docs/python/testing#_test-discovery). This extension brings the same UI functionality to autotools projects.

### Generated test tasks

When you use the automake `TESTS` variable to declare test suites, they are available to run with `make check`, and this exension is able to discover them, and create individual test tasks for each discovered test.

The test tasks allow:
    * creating [Compound Tasks](https://code.visualstudio.com/docs/editor/tasks#_compound-tasks)
    * keybinding frequently used test suites.
    * One-click access to each test's output file (log file)


### Debugging tests

Tests that fail can be debugged with a single click. The extension is a [`DebugConfigurationProvider`](https://code.visualstudio.com/api/extension-guides/debugger-extension) which means it can configure the debugger with the same runtime environment that the test normally runs in, without any manual intervention, allowing you to focus on finding the bugs, not on starting the debugger.

Specifically, tests are supplied with the same environment a automake's [`TESTS_ENVIRONMENT` mechanism](https://www.gnu.org/software/automake/manual/html_node/Serial-Test-Harness.html) as described [below](#test-environments), and the [`srcdir`](https://www.gnu.org/software/automake/manual/html_node/Scripts_002dbased-Testsuites.html) variable which is automatically calculated.

Whether the test runs directly or under the debugger, it is provided the same environment.

Additionally, tests that rely on built shared libraries likely use [libtool](https://www.gnu.org/software/libtool/) to manage running and debugging the project in its uninstalled test. This ensures that the `LD_LIBRARY_PATH` is appropriately set. The extension ensures that the correct shared library is linked, whether the test runs directly or under the debugger, by transparently using the libtool logic. Typically, debugging libtool programs is tricky to do correctly, and this extension saves development time by implementing invoking the debugger with the appropriate wrapping for the test being debugged.

**Note** The extension currently supports only the Parallel Test Harness, but the "older (and discouraged)" harness will be supported in a future version, for compatibility with legacy autotools projects.

### Test Environments

Autotools provide the ability to run a test suite under any arbitrary test environment, using the `TESTS_ENVIRONMENT` user-variable mechanism. This extension implements this mechanism, and allows you to create any number of environments. You can run individual tests or full test suite under one or more environments.

Example workspace settings:
```json
"autotools.test-environments": {
    "Legacy-A": [ "DATADIR=legacyA", "HASHALGO=md5" ],
    "Legacy-B": [ "DATADIR=legacyB", "HASHALGO=sha1" ],
    "Modern":   [ "DATADIR=modern",  "HASHALGO=sha256" ],
    "NextGen":  [ "DATADIR=next",    "HASHALGO=qha" ],
}

```

In this example, there are two legacy environments that are tests, one modern, and an avant-garde environment. The environemnt variables that will be set are `DATADIR` and `HASHALGO`. In this envisioned setup, the tests use the `DATADIR` variable in combination with the `srcdir` automatic variable to find a dataset on which to run. They also use the `HASHALGO` variable to configure an arbitrary hashing algorithm to be used with the tests. The fictional `qha` algorithm might mean "quantun hashing algorithm', a future algorithm what the application supports.

A typical test environment can contain any number of environment variables. The generated test task passes them to automake via the `TESTS_ENVIRONMENT` variable when running the tests, and passes them to the debugger using the appropriate [`environment` configuration](https://code.visualstudio.com/docs/cpp/launch-json-reference#_environment) when debugging them.

The environment variable `srcdir` is an automatically set environment variable pointing to the directory where the test's data files should be read from.

### Live Testing

This mode allows test suites to be run when you save edited source files. When a file is saved in the editor, if there are no other modified but not-yet-saved files, a selected test-suite is run under autotools (ie, `make check` in the selected directory, and with a selected list of tests). Autotools first builds any tests that depend on the newly modified sources, and then runs the test suite. The extension watches the filesystem and updates the test results in the Testing UI, live, as they become available.

You choose which tests are selected to run 'live', and when they run (ie, when you 'Save' or 'Save All'). You can continue making changes to the sources even as the tests run. The extension will ensure that the final test results shown in the Testing UI reflect the final saved state of the project.








# VS Code Makefile Tools (Mergesium edition)

This extension allows Intellisense to import configuration from Makefile projects.
It also provides convenient commands to build, debug, and run your targets.

It is a fork of [Microsoft's extension of the same name](https://github.com/microsoft/vscode-makefile-tools), and includes several [Mergesium customizations](#differences-from-makefile-tools). Mergesium offers these improvements to Microsoft as pull requests, but they may or may not be accepted for upstream inclusion. It should be considered a technology preview, showcasing Mergesium's vision; an easy way to try out the proposed improvements.

Autotools is the main build system used at Mergesium, and thus we need this extension to be as useful to us as possible. We eat the dogfood we make. If you're already familiar with vscode-makefile-tools, you can skip to [Differences from makefile-tools](#differences-from-makefile-tools).

# Getting Started

### Activating the extension
The extension will activate when it finds a Makefile in your `${workspaceFolder}`. If your Makefile does not
reside in the root of your folder, use the `makefile.makefilePath` (which generates the make switch -f)
or `makefile.makeDirectory` (which generates the make switch -C) settings to instruct the extension where to find it.

### Pre-configuring your project
If you need any environment variables to be set or any terminal operations to be run before configure/build
(like the usual `./autogen.sh`, `./configure` or `vcvarsall.bat`), you need to launch VSCode from a terminal
that is already set up according to your project requirements OR you can point the `makefile.preConfigureSript`
setting to a batch script file and invoke it at any time via the command `makefile.preconfigure` in the pallette.
By setting `makefile.alwaysPreConfigure` to true, you don't need to run the pre-configure command separately.
The extension is going to invoke the script before every configure operation.

### Configuring your project
By default, the extension will attempt to use a `make` program that resides within your $PATH to configure
the project.  If you use a different flavor of the make tool or if it is not in your $PATH, use the
`makefile.makePath` setting to instruct the extension where to find it.  Provide a file/command that is in the
system path, prefixed with `${workspaceRoot}`, or an absolute path as relative paths will not be resolved
properly.

The extension can also avoid running the `make` program when it configures your project, if you point the
`makefile.buildLog` setting to the output of a build.

Now, you are ready to configure your project. If you normally just run `make` in the terminal to
configure/build your project, you shouldn't need to do anything else at this point besides accept the prompt
from cpptools to allow this extension to configure IntelliSense:

![image](https://user-images.githubusercontent.com/12818240/94731434-9d1e3380-0319-11eb-98c4-cb80218b1b8b.png)

If you don't see that message, or you accidentally dismissed it, you can grant Makefile Tools permission to
configure IntelliSense by running the `C/C++: Change Configuration Provider...` command and selecting Makefile
Tools from the list.

If you regularly pass additional arguments to `make`, you should use the `makefile.configurations` setting
to create a configuration object and specify the arguments to pass to `make` with the `makeArgs` property.
There are other options you can configure in this object as well. If you configure `make` in multiple
different ways, you can create multiple configuration objects with different arguments. Just make sure to
give your configurations a unique `name` so that you can tell them apart.

### Building targets

To build a target, run the `Makefile: Set the target to be built by make` command (default target is "all")
and then run the `Makefile: Build the current target`.  There are also convenience commands to build ALL,
build clean, etc. without having to change your active build target.

### Debugging and running targets

To Debug or run a target, run the `Makefile: Set the make launch configuration` command and select the target
you want to debug or run. If a configuration for that target has not already been added to the
`makefile.launchConfigurations` setting, then one will be added for you at this time.  Then run the 
`Makefile: Debug the selected binary target` or `Makefile: Run the selected binary target in the terminal` 
command to start debugging or running the target without a debugger attached.

If you need to pass additional arguments to your targets, update the `makefile.launchConfigurations` by adding
the `binaryArgs` property to the configuration.

# Troubleshooting

We documented the settings and configurations needed for a select number of repositories that we have
tested. The document can be found here: [docs/repositories.md](./docs/repositories.md). Contributions to this
document (e.g. for additional repositories that we have not tested) are welcome.

A more in-depth troubleshooting guide can be found here: [docs/troubleshooting.md](./docs/troubleshooting.md)

# Feedback and Suggestions

We'd love to hear what you think! If you are having trouble with the extension, please
[open an issue](https://github.com/Mergesium/vscode-makefile-tools/issues/new).

You can also leave us a rating on the VS Code Marketplace and let us know what you like about the extension
or would like to see improved.

# Contributing

(Note: this section needs work)

This project welcomes contributions and suggestions. The upsteam (Microsoft) has a
Contributor License Agreement (CLA) management plan, which is not practical for a small company like Mergesium.
If you contribute directly to us, we will not forward it to Microsoft. If you want it included in the upstream project, contribute it directly there. You can of course, submit it to both Mergesium and Microsoft if you choose.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or
contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Differences from makefile-tools
* compatible with autotools (ie, fixes the infinite dry-run bug)
* compatible with out-of-tree build configurations
  * allows multiple configurations to be built from the same source, in different object directories
* (Optionally) save dry-run results in the builddir
  * allows easy detection of configuration changes (if you store .vscode/${currentTarget}.dryrun.log in git)
  * also allows saving the dry-run to be skipped, saving disk space if you don't need this generated output.
* Uses terminology that is more intuitive to experienced autotools users:
  * "srcdir" instead of "workspace"
  * "builddir" instead of "makeDirectory"
  * "import to Intellisense" instead of "configure" (ie, "configure" does not mean running the configure script, but it means to extract the configuration data from the generated Makefile)
* streamlined configuration
  * each "Build Configuration" comprises of a build dir and an optional makeArgs setting. No more inheriting from the "Default" configuration, which makes no sense.
  * removes the "buildLog" which was a workaround for the infinite dry-run bug, but it causes more grief than it solves.

## From Mergesium's TODO list:

* sandbox mode to avoid accidental fork-bombing (https://github.com/microsoft/vscode-makefile-tools/issues/505)
* libtool compatibility (so libtool projects can be seamlessly debugged in vscode - currently they require much scriptology)
* ability to configure most freshly cloned well-formed autotools projects. This may require
  * exposing the configurable options in the gui, and
  * detecting the right way to bootstrap it (./configure, ./autoreconf -vi, something else?)
* Do you have suggestions? -> [open an Issue](https://github.com/drok/vscode-makefile-tools/issues)

## Data and telemetry

This extension collects usage data and sends it to Microsoft to help improve their products and services. Collection of telemetry is controlled via the same setting provided by Visual Studio Code: `"telemetry.enableTelemetry"`. Read their [privacy statement](https://privacy.microsoft.com/en-us/privacystatement) to learn more.
