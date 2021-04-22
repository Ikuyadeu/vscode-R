/* eslint-disable @typescript-eslint/no-explicit-any */


import * as vscode from 'vscode';
import { Httpgd } from './httpgd';
import { HttpgdPlot, IHttpgdViewer, HttpgdViewerOptions, PlotId, ExportFormat, HttpgdState } from './httpgdTypes';
import * as path from 'path';
import * as fs from 'fs';
import * as ejs from 'ejs';

import { config, setContext } from './util';

import { extensionContext } from './extension';

interface IOutMessage {
  message: string;
}
interface ResizeMessage extends IOutMessage {
  message: 'resize',
  height: number,
  width: number
}
interface LogMessage extends IOutMessage {
  message: 'log',
  body: any
}

type OutMessage = ResizeMessage | LogMessage;

const commands = [
    'showIndex',
    'toggleStyle',
    'exportPlot',
    'nextPlot',
    'prevPlot',
    'hidePlot',
    'closePlot',
    'resetPlots'
] as const;

type CommandName = typeof commands[number];

export function initializeHttpgd(): HttpgdManager {
    const httpgdManager = new HttpgdManager();
    for(const cmd of commands){
        const fullCommand = `r.httpgd.${cmd}`;
        const cb = httpgdManager.getCommandHandler(cmd);
        vscode.commands.registerCommand(fullCommand, cb);
    }
    return httpgdManager;
}

export class HttpgdManager {
    viewers: HttpgdViewer[] = [];
    
    viewerOptions: HttpgdViewerOptions;
    
    recentlyActiveViewers: HttpgdViewer[] = [];
    
    constructor(){
        const htmlRoot = extensionContext.asAbsolutePath('html/httpgd');
        const htmlTemplatePath = path.join(htmlRoot, 'index.ejs');
        this.viewerOptions = {
            parent: this,
            htmlRoot: htmlRoot,
            htmlTemplatePath: htmlTemplatePath,
            preserveFocus: true,
            viewColumn: vscode.ViewColumn.Two
        };
    }

    public showViewer(urlString: string): void {
        const url = new URL(urlString);
        const host = url.host;
        const token = url.searchParams.get('token') || undefined;
        const ind = this.viewers.findIndex(
            (viewer) => viewer.host === host
        );
        if(ind >= 0){
            const viewer = this.viewers.splice(ind, 1)[0];
            this.viewers.unshift(viewer);
            viewer.show();
        } else{
            const colorTheme = config().get('httpgd.defaultColorTheme', 'vscode');
            this.viewerOptions.stripStyles = (colorTheme === 'vscode');
            this.viewerOptions.token = token;
            const viewer = new HttpgdViewer(host, this.viewerOptions);
            this.viewers.unshift(viewer);
        }
    }
    
    public registerActiveViewer(viewer: HttpgdViewer): void {
        const ind = this.recentlyActiveViewers.indexOf(viewer);
        if(ind){
            this.recentlyActiveViewers.splice(ind, 1);
        }
        this.recentlyActiveViewers.unshift(viewer);
    }
    
    public getRecentViewer(): HttpgdViewer | undefined {
        return this.recentlyActiveViewers.find((viewer) => !!viewer.webviewPanel);
    }
    
    public getNewestViewer(): HttpgdViewer | undefined {
        return this.viewers[0];
    }
    
    public getCommandHandler(command: CommandName): (...args: any[]) => void {
        return (...args: any[]) => {
            this.handleCommand(command, ...args);
        };
    }
    
    // generic command handler
    public handleCommand(command: CommandName, hostOrWebviewUri?: string | vscode.Uri, ...args: any[]): void {
        // the number and type of arguments given to a command can vary, depending on where it was called from:
        // - calling from the title bar menu provides two arguments, the first of which identifies the webview
        // - calling from the command palette provides no arguments
        // - calling from a command uri provides a flexible number/type of arguments
        // below  is an attempt to handle these different combinations efficiently and (somewhat) robustly

        // Identify the correct viewer
        let viewer: HttpgdViewer | undefined;
        if(typeof hostOrWebviewUri === 'string'){
            const host = hostOrWebviewUri;
            viewer = this.viewers.find((viewer) => viewer.host === host);
        } else if(hostOrWebviewUri instanceof vscode.Uri){
            const uri = hostOrWebviewUri;
            viewer = this.viewers.find((viewer) => viewer.getPanelPath() === uri.path);
            console.log('asdf');
        } else {
            viewer = this.getRecentViewer();
        }

        // Abort if no viewer identified
        if(!viewer){
            return;
        }
        
        // Get possible arguments for commands:
        const stringArg = findItemOfType(args, 'string');
        const boolArg = findItemOfType(args, 'boolean');
        
        // Call corresponding method, possibly with an argument:
        switch(command) {
            case 'showIndex': {
                viewer.focusPlot(stringArg);
                break;
            } case 'nextPlot': {
                viewer.nextPlot(boolArg);
                break;
            } case 'prevPlot': {
                viewer.prevPlot(boolArg);
                break;
            } case 'resetPlots': {
                viewer.resetPlots();
                break;
            } case 'toggleStyle': {
                viewer.toggleStyle(boolArg);
                break;
            } case 'closePlot': {
                void viewer.closePlot(stringArg);
                break;
            } case 'hidePlot': {
                void viewer.hidePlot(stringArg);
                break;
            } case 'exportPlot': {
                void viewer.exportPlot(stringArg);
                break;
            } default: {
                break;
            }
        }
    }
}


interface EjsData {
    overwriteStyles: boolean;
    activePlot?: PlotId;
    plots: HttpgdPlot[];
    largePlot: HttpgdPlot;
    asWebViewPath: (localPath: string) => string;
    makeCommandUri: (command: string, ...args: any[]) => string;
}


export class HttpgdViewer implements IHttpgdViewer {
    
    parent: HttpgdManager;

    host: string;
    token?: string;

    // Actual webview where the plot viewer is shown
    // Will have to be created anew, if the user closes it and the plot changes
    webviewPanel?: vscode.WebviewPanel;

    // Api that provides plot contents etc.
    api: Httpgd;

    // active plots
    plots: HttpgdPlot[] = [];
    state?: HttpgdState;
    
    // Id of the currently viewed plot
    activePlot?: PlotId;
    
    // Ids of plots that are not shown, but not closed inside httpgd
    hiddenPlots: PlotId[] = [];
    
    stripStyles: boolean;
    
    // Size of the view area:
    height: number;
    width: number;
    
    htmlTemplate: string;
    htmlRoot: string;
    
    showOptions: { viewColumn: vscode.ViewColumn, preserveFocus?: boolean };
    webviewOptions: vscode.WebviewPanelOptions & vscode.WebviewOptions;
    
    private resizeBusy: boolean = false;
    
    // constructor called by the session watcher if a corresponding function was called in R
    // creates a new api instance itself
    constructor(host: string, options: HttpgdViewerOptions) {
        this.host = host;
        this.token = options.token;
        this.parent = options.parent;
        this.api = new Httpgd(this.host, this.token);
        this.api.onPlotsChange(() => {
            void this.refreshPlots();
        });
        this.api.onConnectionChange(() => {
            void this.refreshPlots();
        });
        this.stripStyles = !!options.stripStyles;
        this.htmlTemplate = fs.readFileSync(options.htmlTemplatePath, 'utf-8');
        this.htmlRoot = options.htmlRoot;
        this.showOptions = {
            viewColumn: options.viewColumn ?? vscode.ViewColumn.Two,
            preserveFocus: !!options.preserveFocus
        };
        this.webviewOptions = {
            enableCommandUris: true,
            enableScripts: true
        };
        this.api.start();
    }

	public async setContextValues(mightBeInBackground: boolean = false): Promise<void> {
        if(this.webviewPanel?.active){
            this.parent.registerActiveViewer(this);
            await setContext('r.httpgd.active', true);
            await setContext('r.httpgd.canGoBack', this.activeIndex > 0);
            await setContext('r.httpgd.canGoForward', this.activeIndex < this.plots.length - 1);
        } else if (!mightBeInBackground){
            await setContext('r.httpgd.active', false);
        }
	}
    
    public getPanelPath(): string | undefined {
        if(!this.webviewPanel) {
            return undefined;
        }
        const dummyUri = this.webviewPanel.webview.asWebviewUri(vscode.Uri.file(''));
        const m = /^https?:\/\/([^.]*)\./.exec(dummyUri.toString());
        const webviewId = m[1] || '';
        return `webview-panel/webview-${webviewId}`;
    }

    async checkState(): Promise<void> {
        const oldState = this.state;
        this.state = await this.api.getState();
        if(this.state.upid !== oldState?.upid){
            void this.refreshPlots();
        }
    }

    async handleResize(height: number, width: number): Promise<void> {
        this.resizeBusy = true;
        const plt = await this.api.getPlotContent(this.activePlot, height, width);
        // this.plots[this.activeIndex] = plt;
        this.width = width;
        this.height = height;
        const msg = {
            message: 'updatePlot',
            id: 'svg',
            svg: plt.svg,
            plotId: plt.id
        };
        this.webviewPanel?.webview.postMessage(msg);
        this.resizeBusy = false;
    }

    async refreshPlots(): Promise<void> {
        const mosteRecentPlotId = this.plots[this.plots.length - 1]?.id;
        const nPlots = this.plots.length;
        let plotIds = await this.api.getPlotIds();
        plotIds = plotIds.filter((id) => !this.hiddenPlots.includes(id));
        const newPlots = plotIds.map(async (id) => {
            const plot = this.plots.find((plt) => plt.id === id);
            if(plot && id !== this.activePlot){
                return plot;
            } else{
                return await this.api.getPlotContent(id, this.height, this.width);
            }
        });
        this.plots = await Promise.all(newPlots);
        if(this.plots.length !== nPlots){
            this.activePlot = this.plots[this.plots.length - 1]?.id;
        }
        this.refreshHtml();
    }
    
    refreshHtml(): void {
        if(!this.webviewPanel){
            this.webviewPanel = vscode.window.createWebviewPanel(
                'RPlot',
                'R Plot',
                this.showOptions,
                this.webviewOptions
            );
            this.webviewPanel.onDidDispose(() => this.webviewPanel = undefined);
            this.webviewPanel.onDidChangeViewState(() => {
                void this.setContextValues();
            });
            this.webviewPanel.webview.onDidReceiveMessage((e: OutMessage) => {
                console.log(e);
                if(this.resizeBusy){
                    console.log('Resize busy');
                } else if(e.message === 'resize'){
                    const height = e.height;
                    const width = e.width;
                    void this.handleResize(height, width);
                }
            });
        }
        this.webviewPanel.webview.html = this.makeHtml();
        void this.setContextValues(true);
    }
    
    makeHtml(): string {
        const asWebViewPath = (localPath: string) => {
            if(!this.webviewPanel){
                return localPath;
            }
            const localUri = vscode.Uri.file(path.join(this.htmlRoot, localPath));
            const webViewUri = this.webviewPanel.webview.asWebviewUri(localUri);
            return webViewUri.toString();            
        };
        const makeCommandUri = (command: string, ...args: any[]) => {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            args = [this.host, ...args];
            const argString = encodeURIComponent(JSON.stringify(args));
            return `command:${command}?${argString}`;
        };
        const ejsData: EjsData = {
            overwriteStyles: this.stripStyles,
            plots: this.plots,
            largePlot: this.plots[this.activeIndex],
            activePlot: this.activePlot,
            asWebViewPath: asWebViewPath,
            makeCommandUri: makeCommandUri
        };
        const html = ejs.render(this.htmlTemplate, ejsData);
        return html;
    }
    
    get activeIndex(): number {
        return this.plots.findIndex((plt: HttpgdPlot) => plt.id === this.activePlot);
    }
    set activeIndex(ind: number) {
        if(this.plots.length === 0){
            this.activePlot = undefined;
        } else{
            ind = Math.max(ind, 0);
            ind = Math.min(ind, this.plots.length - 1);
            this.activePlot = this.plots[ind].id;
        }
    }

    // Methods to interact with the webview
    // Can e.g. be called by vscode commands + menu items:

    // Called to create a new webview if the user closed the old one:
    show(preserveFocus?: boolean): void {
        this.parent.registerActiveViewer(this);
        // pass
    }
    
    // focus a specific plot id
    focusPlot(id?: PlotId): void {
        this.activePlot = id;
        this.refreshHtml();
    }
    
    // navigate through plots (supply `true` to go to end/beginning of list)
    nextPlot(last?: boolean): void {
        this.activeIndex = last ? this.plots.length - 1 : this.activeIndex+1;
        this.refreshHtml();
    }
    prevPlot(first?: boolean): void {
        this.activeIndex = first ? 0 : this.activeIndex-1;
        this.refreshHtml();
    }
    
    // restore closed plots, show most recent plot etc.?
    resetPlots(): void {
        this.hiddenPlots = [];
        void this.refreshPlots();
    }
    
    hidePlot(id?: PlotId): void {
        id ??= this.activePlot;
        if(id){
            const tmpIndex = this.activeIndex;
            this.hiddenPlots.push(id);
            this.plots = this.plots.filter((plt) => !this.hiddenPlots.includes(plt.id));
            if(id === this.activePlot){
                this.activeIndex = tmpIndex;
            }
            this.refreshHtml();
        }
    }
    
    async closePlot(id?: PlotId): Promise<void> {
        id ??= this.activePlot;
        await this.api.closePlot(id);
        await this.refreshPlots();
    }
    
    toggleStyle(force?: boolean): void{
        this.stripStyles = force ?? !this.stripStyles;
        this.refreshHtml();
    }
    
    // export plot
    // if no format supplied, show a quickpick menu etc.
    // if no filename supplied, show selector window
    async exportPlot(id?: PlotId, format?: ExportFormat, outFile?: string): Promise<void> {
        // make sure id is valid or return:
        id ||= this.activePlot || this.plots[this.plots.length-1]?.id;
        const plot = this.plots.find((plt) => plt.id === id);
        if(!plot){
            void vscode.window.showWarningMessage('No plot available for export.');
            return;
        }
        // make sure format is valid or return:
        if(!format){
            const formats: ExportFormat[] = ['svg'];
            const options: vscode.QuickPickOptions = {
                placeHolder: 'Please choose a file format'
            };
            format = await vscode.window.showQuickPick(formats, options) as ExportFormat | undefined;
            if(!format){
                return;
            }
        }
        // make sure outFile is valid or return:
        if(!outFile){
            const options: vscode.SaveDialogOptions = {};
            const outUri = await vscode.window.showSaveDialog(options);
            outFile = outUri?.fsPath;
            if(!outFile){
                return;
            }
        }
        // actually export plot:
        if(format === 'svg'){
            // do export
            fs.writeFileSync(outFile, plot.svg);
            const uri = vscode.Uri.file(outFile);
            // await vscode.workspace.openTextDocument(uri);
            void vscode.window.showTextDocument(uri);
        } else{
            void vscode.window.showWarningMessage('Format not implemented');
        }
    }

    // Dispose-function to clean up when vscode closes
    // E.g. to close connections etc., notify R, ...
    dispose(): void {
        this.api.dispose();
    }
}

// helper function to handle argument lists that might contain (useless) extra arguments
function findItemOfType(arr: any[], type: 'string'): string | undefined;
function findItemOfType(arr: any[], type: 'boolean'): boolean | undefined;
function findItemOfType(arr: any[], type: 'number'): number | undefined;
function findItemOfType<T = unknown>(arr: any[], type: string): T {
    const item = arr.find((elm) => typeof elm === type) as T;
    return item;
}
