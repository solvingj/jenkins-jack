import * as vscode from 'vscode';
import * as util from "util";
import * as xml2js from "xml2js";
import * as htmlParser from 'cheerio';

import { sleep, getPipelineJobConfig } from './utils';
import { JenkinsService } from './JenkinsService';

const parseXmlString = util.promisify(xml2js.parseString) as any as (xml: string) => any;

class PipelineSharedLibVar {
    label: string;
    description?: string;
    descriptionHtml?: string;

    constructor(name: string, description: string, descriptionHtml: string) {
        this.label = name;
        this.description = description;
        this.descriptionHtml = descriptionHtml;
    }
}

/**
 * Struct for storing a Pipeline's build information.
 */
class PipelineBuild {
    job: string;
    nextBuildNumber: number;
    source: string;
    hasParams: boolean;

    constructor(
        jobName: string,
        source: string = '',
        buildNumber: number = -1,
        hasParams: boolean = false) {
        this.job = jobName;
        this.source = source;
        this.nextBuildNumber = buildNumber;
        this.hasParams = hasParams;
    }
}

export class Pipeline {
    // Settings
    jobPrefix: string | undefined;
    browserSharedLibraryRef: string;
    browserBuildOutput: boolean;
    outputPanel: vscode.OutputChannel;
    timeoutSecs: number;

    lastBuild?: PipelineBuild;
    activeBuild?: PipelineBuild;
    sharedLibVars: PipelineSharedLibVar[];
    readonly pollMs: number;
    readonly barrierLine: string;

    readonly jenkins: JenkinsService;

    constructor(pipelineConfig: any) {
        this.jobPrefix = pipelineConfig.jobPrefix;
        this.browserBuildOutput = pipelineConfig.buildOutput;
        this.browserSharedLibraryRef = pipelineConfig.browserSharedLibraryRef;

        this.timeoutSecs = 10;
        this.pollMs = 100;
        this.barrierLine = '-'.repeat(80);
        this.sharedLibVars = [];

        this.outputPanel = vscode.window.createOutputChannel("Jenkins-Jack");
        this.jenkins = JenkinsService.instance();
    }

    public updateSettings(pipelineConfig: any) {
        this.browserBuildOutput = pipelineConfig.buildOutput;
        this.browserSharedLibraryRef = pipelineConfig.browserSharedLibraryRef;
    }

    public async executeConsoleScript(source: string) {
        let nodes = await this.jenkins.getNodes();
        if (undefined === nodes) { return; }
        nodes.map((n: any) => {
            n.label = n.displayName;
            n.description = n.offline ? "$(alert)" : "";
        });

        let options = Object.assign([], nodes);
        options.unshift({
            label: "System",
            description: "Executes from the System Script Console found in 'Manage Jenkins'."
        });
        options.unshift({
            label: ".*",
            description: "Regex of the nodes you would like to target."
        });

        // Grab initial selection from the user.
        let selection = await vscode.window.showQuickPick(options) as any;
        if (undefined === selection) { return; }

        let targetMachines: any[] = [];

        // If regex specified, grab a pattern from the user to
        // filter on the list of nodes.
        if ('.*' === selection.label) {
            // Grab regex pattern from user.
            let pattern = await vscode.window.showInputBox();
            if (undefined === pattern) { return; }

            // Match against list of nodes.
            let matches = [];
            for (let n of nodes) {
                let name = n.displayName as string;
                let match = name.match(pattern);
                if (null !== match && match.length >= 0) {
                    matches.push(n);
                }
            }

            // Allow the user to select nodes retrieved from regex.
            let selections = await vscode.window.showQuickPick(matches, { canPickMany: true } );
            if (undefined === selections) { return; }
            targetMachines = targetMachines.concat(selections.map(s => s.label));
        }
        else if ('System' === selection.label) {
            targetMachines.push('System');
        }
        else {
            targetMachines.push(selection.label);
        }

        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Console Script(s)`,
            cancellable: true
        }, async (progress, token) => {
            token.onCancellationRequested(() => {
                vscode.window.showWarningMessage(`User canceled pipeline build.`);
            });

            // Build a list of console script requests across the list of targeted machines
            // and await across all.
            let tasks = [];
            progress.report({ increment: 50, message: "Executing on target machine(s)" });
            for (let m of targetMachines) {
                let promise = undefined;
                if ('System' === m) {
                    promise = new Promise(async (resolve) => {
                        let result = await this.jenkins.runConsoleScript(source);
                        return resolve({ node: 'System', output: result });
                    })
                }
                else {
                    promise = new Promise(async (resolve) => {
                        let result = await this.jenkins.runConsoleScript(source, m);
                        return resolve({ node: m, output: result });
                    })
                }
                tasks.push(promise);
            }
            let results = await Promise.all(tasks);

            // Iterate over the result list, printing the name of the
            // machine and it's output.
            this.outputPanel.clear();
            this.outputPanel.show();
            for (let r of results as any[]) {
                this.outputPanel.appendLine(this.barrierLine);
                this.outputPanel.appendLine(r.node);
                this.outputPanel.appendLine('');
                this.outputPanel.appendLine(r.output);
                this.outputPanel.appendLine(this.barrierLine);
            }

            progress.report({ increment: 50, message: `Output retrieved. Displaying in OUTPUT channel...` });
        });
    }

    /**
     * Downloads a build log for the user by first presenting a list
     * of jobs to select from, and then a list of build numbers for
     * the selected job.
     */
    public async downloadBuildLog() {
        let jobs = await this.jenkins.getJobs(undefined);
        if (undefined === jobs) { return; }
        for (let job of jobs) {
            job.label = job.fullName;
        }

        // Ask which job they want to target.
        let job = await vscode.window.showQuickPick(jobs)
        if (undefined === job) { return; }

        // Ask what build they want to download.
        let buildNumbers = await this.jenkins.getBuildNumbersFromUrl(job.url);
        let buildNumber = await vscode.window.showQuickPick(buildNumbers);
        if (undefined === buildNumber) { return; }

        // Stream it. Stream it until the editor crashes.
        await this.streamOutput(job.label, parseInt(buildNumber));
    }

    /**
     * Displays a list of Shared Library steps/vars for the user to select.
     * On selection, will display a web-view of the step's documentation.
     */
    public async showSharedLibVars() {
        await this.refreshSharedLibraryApi();
        let result = await vscode.window.showQuickPick(this.sharedLibVars);
        if (undefined === result) { return; }
        if (this.browserSharedLibraryRef) {
            if (undefined === this.lastBuild) {
                this.jenkins.openBrowserAt(`pipeline-syntax/globals#${result.label}`);
            }
            else {
                this.jenkins.openBrowserAt(`job/${this.lastBuild.job}/pipeline-syntax/globals#${result.label}`);
            }
        }
        else {
            const panel = vscode.window.createWebviewPanel(
                'pipeline shared lib',
                result.label,
                vscode.ViewColumn.Beside,
                {}
            );
            panel.webview.html = `<html>${result.descriptionHtml}</html>`;
        }
    }

    /**
     * Refreshes/updates the Pipeline Shared Library definitions.
     */
    private async refreshSharedLibraryApi() {
        this.sharedLibVars = [];

        let url = undefined !== this.lastBuild ?
                                `job/${this.lastBuild.job}/pipeline-syntax/globals` :
                                'pipeline-syntax/globals';
        let html = await this.jenkins.get(url);

        const root = htmlParser.load(html);
        let doc = root('.steps.variables.root').first();

        let child = doc.find('dt').first();
        while (0 < child.length) {
            // Grab name, description, and html for the shared var.
            let name = child.attr('id');
            let descr = child.next('dd').find('div').first().text().trim();
            let html = child.next('dd').find('div').first().html();
            if (null === descr || null === html) { continue; }

            // Add shared var name as title to the content.
            html = `<div id='outer' markdown='1'><h2>${name}</h2>${html}</div>`;
            if (!this.sharedLibVars.some((slv: PipelineSharedLibVar) => slv.label === name)) {
                this.sharedLibVars.push(new PipelineSharedLibVar(name, descr, html));
            }

            // Get the next shared var.
            child = child.next('dd').next('dt');
        }
    }

    /**
     * Streams the log output of the provided build to
     * the output panel.
     * @param jobName The name of the job.
     * @param buildNumber The build number.
     */
    public streamOutput(jobName: string, buildNumber: number) {
        this.outputPanel.show();
        this.outputPanel.clear();
        this.outputPanel.appendLine(this.barrierLine);
        this.outputPanel.appendLine(`Streaming console ouptput...`);
        this.outputPanel.appendLine(this.barrierLine);

        var log = this.jenkins.client.build.logStream({
            name: jobName,
            number: buildNumber,
            delay: 500
        });

        log.on('data', (text: string) => {
            this.outputPanel.appendLine(text);
        });

        log.on('error', (err: string) => {
            this.outputPanel.appendLine(`[ERROR]: ${err}`);
        });

        log.on('end', () => {
            this.outputPanel.appendLine(this.barrierLine);
            this.outputPanel.appendLine('Console stream ended.');
            this.outputPanel.appendLine(this.barrierLine);
            this.lastBuild = this.activeBuild;
            this.activeBuild = undefined;
        });
    }

    /**
     * Blocks until a build is ready. Will timeout after a seconds
     * defined in global timeoutSecs.
     * @param jobName The name of the job.
     * @param buildNumber The build number to wait on.
     */
    public async buildReady(jobName: string, buildNumber: number) {
        let timeout = this.timeoutSecs;
        let exists = false;
        console.log('Waiting for build to start...');
        while (timeout-- > 0) {
            exists = await this.jenkins.client.build.get(jobName, buildNumber).then((data: any) => {
                return true;
            }).catch((err: any) => {
                return false;
            });
            if (exists) { break; }
            await sleep(1000);
        }
        if (!exists) {
            throw new Error(`Timed out waiting waiting for build after ${this.timeoutSecs} seconds: ${jobName}`);
        }
        console.log('Build ready!');
    }

    /**
     * Creates or update the provides job with the passed Pipeline source.
     * @param source The scripted Pipeline source.
     * @param job The Jenkins Pipeline job name.
     */
    public async createUpdatePipeline(source: string, job: string) {
        let jobName = job;
        let xml = getPipelineJobConfig();

        // Format job name based on configuration setting.
        if (undefined !== this.jobPrefix && this.jobPrefix.trim().length > 0) {
            jobName = `${this.jobPrefix}-${jobName}`;
        }

        let build = new PipelineBuild(jobName, source);
        let data = await this.jenkins.getJob(jobName);
        if (undefined === data) { return undefined; }

        // If job already exists, grab the job config xml from Jenkins.
        if (data) {
            // Evaluated if this job has build parameters and set the next build number.
            let param = data.property.find((p: any) => p._class.includes("ParametersDefinitionProperty"));
            build.hasParams = param !== undefined;
            build.nextBuildNumber = data.nextBuildNumber;

            // Grab job's xml configuration.
            xml = await this.jenkins.client.job.config(jobName).then((data: any) => {
                return data;
            }).catch((err: any) => {
                return undefined;
            });
        }

        // TODO: should probably handle this somehow.
        if (undefined === xml) { return; }

        // Inject the provided script/source into the job configuration.
        let parsed = await parseXmlString(xml);
        let root = parsed['flow-definition'];
        root.definition[0].script = source;
        root.quietPeriod = 0;
        xml = new xml2js.Builder().buildObject(parsed);

        if (!data) {
            console.log(`${jobName} doesn't exist. Creating...`);
            await this.jenkins.client.job.create(jobName, xml);
        }
        else {
            console.log(`${jobName} already exists. Updating...`);
            await this.jenkins.client.job.config(jobName, xml);
        }
        console.log(`Successfully updated Pipeline: ${jobName}`);
        return build;
    }

    /**
     * Updates the targeted Pipeline job with the given script/source.
     * @param source The pipeline script source to update to.
     * @param job The name of the job to update.
     */
    public async updatePipeline(source: string, job: string) {
        if (undefined !== this.activeBuild) {
            vscode.window.showWarningMessage(`Already building/streaming - ${this.activeBuild.job}: #${this.activeBuild.nextBuildNumber}`);
            return;
        }

        this.outputPanel.show();
        this.outputPanel.clear();

        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Updating ${job}`,
            cancellable: true
        }, async (progress, token) => {
            token.onCancellationRequested(() => {
                vscode.window.showWarningMessage(`User canceled pipeline update.`);
            });
            progress.report({ increment: 50 });
            return new Promise(async resolve => {
                await this.createUpdatePipeline(source, job);
                resolve();
            });
        });
    }

    /**
     * Builds the targeted job with the provided Pipeline script/source.
     * @param source Scripted Pipeline source.
     * @param jobName The name of the job.
     */
    public async buildPipeline(source: string, job: string) {
        if (undefined !== this.activeBuild) {
            vscode.window.showWarningMessage(`Already building/streaming - ${this.activeBuild.job}: #${this.activeBuild.nextBuildNumber}`);
            return;
        }

        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Pipeline ${job}`,
            cancellable: true
        }, async (progress, token) => {
            token.onCancellationRequested(() => {
                vscode.window.showWarningMessage(`User canceled pipeline build.`);
            });

            progress.report({ increment: 0, message: `Creating/updating Pipeline job.` });
            this.activeBuild = await this.createUpdatePipeline(source, job);
            if (undefined === this.activeBuild) { return; }

            // TODO: figure out a nice, user friendly, way that allows users to input build parameters
            // for their pipeline builds. For now, we pass empty params to ensure it builds.
            progress.report({ increment: 30, message: `Building "${this.activeBuild.job} #${this.activeBuild.nextBuildNumber}` });
            let buildOptions = this.activeBuild.hasParams ? { name: this.activeBuild.job, parameters: {} } : { name: this.activeBuild.job };
            await this.jenkins.client.job.build(buildOptions).catch((err: any) => {
                console.log(err);
                throw err;
            });

            progress.report({ increment: 20, message: `Waiting for build to be ready...` });
            await this.buildReady(this.activeBuild.job, this.activeBuild.nextBuildNumber);
            progress.report({ increment: 50, message: `Build is ready! Streaming output...` });

            return new Promise(resolve => {
                if (undefined === this.activeBuild) {
                    resolve();
                    return;
                }
                this.streamOutput(this.activeBuild.job, this.activeBuild.nextBuildNumber);
                resolve();
            });
        });
    }

    /**
     * Aborts the active pipeline build.
     */
    public async abortPipeline() {
        if (undefined === this.activeBuild) { return; }
        await this.jenkins.client.build.stop(this.activeBuild.job, this.activeBuild.nextBuildNumber).then(() => { });
        this.activeBuild = undefined;
    }
}