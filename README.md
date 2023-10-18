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

### Post-configuring your project
If you need any environment variables to be set, modified, or deleted, or any terminal operations to be run after configure/build,
you need to launch VSCode from a terminal that is already set up according to your project requirements OR
you can point the `makefile.postConfigureScript` setting to a batch script file and invoke it at any time via the
command `makefile.postConfigure` in the pallette. By setting `makefile.alwaysPostConfigure` to true,
you don't need to run the post-configure command separately. The extension is going to invoke the script after every configure operation.

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
