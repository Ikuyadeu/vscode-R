/* eslint-disable @typescript-eslint/no-explicit-any */

import * as vscode from 'vscode';
import * as cheerio from 'cheerio';
import * as hljs from 'highlight.js';

import * as api from './api';

import { config, getRpath, doWithProgress, DummyMemento } from './util';
import { HelpPanel } from './rHelpPanel';
import { HelpProvider, AliasProvider } from './rHelpProvider';
import { HelpTreeWrapper } from './rHelpTree';
import { PackageManager } from './rHelpPackages';


// Initialization function that is called once when activating the extension
export async function initializeHelp(context: vscode.ExtensionContext, rExtension: api.RExtension): Promise<RHelp|undefined> {

	// set context value to indicate that the help related tree-view should be shown
	void vscode.commands.executeCommand('setContext', 'r.helpViewer.show', true);

    // get the "vanilla" R path from config
    const rPath = await getRpath(true, 'helpPanel.rpath');

	// get the current working directory from vscode
	const cwd = (
		vscode.workspace.workspaceFolders?.length ?
		vscode.workspace.workspaceFolders[0].uri.fsPath :
		undefined
	);

	// get the Memento for storing cached help files (or create a dummy for this session)
	const cacheConfig = config().get<'None'|'Workspace'|'Global'>('helpPanel.cacheIndexFiles');
	const persistentState = (
		cacheConfig === 'Workspace' ? context.workspaceState :
		cacheConfig === 'Global' ? context.globalState :
		new DummyMemento()
	);

	// Gather options used in r help related files
    const rHelpOptions: HelpOptions = {
        webviewScriptPath: context.asAbsolutePath('/html/script.js'),
        webviewStylePath: context.asAbsolutePath('html/theme.css'),
		rScriptFile: context.asAbsolutePath('R/getAliases.R'),
        rPath: rPath,
        cwd: cwd,
		persistentState: persistentState
    };

	let rHelp: RHelp | undefined = undefined;

    try{
		rHelp = new RHelp(rHelpOptions);
    } catch(e) {
        void vscode.window.showErrorMessage(`Help Panel not available`);
    }

    rExtension.helpPanel = rHelp;

	if(rHelp){
		// make sure R child processes etc. are terminated when extension closes
		context.subscriptions.push(rHelp);

		// register help related commands
		context.subscriptions.push(
			vscode.commands.registerCommand('r.showHelp', () => rHelp?.treeViewWrapper.helpViewProvider.rootItem.showQuickPick()),
			vscode.commands.registerCommand('r.helpPanel.back', () => rHelp?.goBack()),
			vscode.commands.registerCommand('r.helpPanel.forward', () => rHelp?.goForward()),
			vscode.commands.registerCommand('r.helpPanel.openExternal', () => rHelp?.openExternal())
		);
	}

	return rHelp;
}


// Internal representation of a help file
export interface HelpFile {
	// content of the file
	html: string;
	// whether the html has been modified already (syntax highlighting etc.)
	isModified?: boolean;
	// original content of the file (only used if isModified===true)
	html0?: string;
	// flag indicating whether the original file content is html
	isHtml?: boolean;
	// path as used by help server. Uses '/' as separator!
	requestPath: string;
	// hash-part of the requested URL
	hash?: string;
    // if the file is a real file
	isRealFile?: boolean;
	// can be used to scroll the document to a certain position when loading
	// useful to remember scroll position when going back/forward
	scrollY?: number;
	// used to open the file in an external browser
	url?: string;
}

// Internal representation of an "Alias"
export interface Alias {
	// name of a help topic as presented to the user
	name: string,
	// name of a help topic as used by the help server
	alias: string,
	// name of the package the alias is from
    package: string
}


// Options to be specified when creating a new rHelp instance (used only once per session)
export interface HelpOptions {
	/* Local path of script.js, used to send messages to vs code */
	webviewScriptPath: string;
	/* Local path of theme.css, used to actually format the highlighted syntax */
	webviewStylePath: string;
	// path of the R executable
    rPath: string;
	// directory in which to launch R processes
	cwd?: string;
	// path of getAliases.R
	rScriptFile: string;
	// persistent state, either global or workspace specific
	persistentState: vscode.Memento;
	// used by some helper classes:
	rHelp?: RHelp;
}


// The name api.HelpPanel is a bit misleading
// This class manages all R-help and R-packages related functions
export class RHelp implements api.HelpPanel {

	// Path of a vanilla R installation
	readonly rPath: string;

	// If applicable, the currently opened wd.
	// Used to read the correct .Rprofile when launching R
	readonly cwd?: string;

	// Provides the content of help pages:
	readonly helpProvider: HelpProvider;

	// Provides a list of aliases:
	readonly aliasProvider: AliasProvider;

	// Show/Install/Remove packages:
	readonly packageManager: PackageManager;

	// The tree view that shows available packages and help topics
	readonly treeViewWrapper: HelpTreeWrapper;

	// the webview panel(s) where the help is shown
	private readonly helpPanels: HelpPanel[] = [];

	// locations on disk, only changed on construction
	readonly webviewScriptFile: vscode.Uri; // the javascript added to help pages
	readonly webviewStyleFile: vscode.Uri; // the css file applied to help pages

	// cache for modified help files (syntax highlighting etc.)
	private cachedHelpFiles: Map<string, HelpFile | null> = new Map<string, HelpFile | null>();

	// The options used when creating this instance
	private helpPanelOptions: HelpOptions;

	constructor(options: HelpOptions){
		this.webviewScriptFile = vscode.Uri.file(options.webviewScriptPath);
		this.webviewStyleFile = vscode.Uri.file(options.webviewStylePath);
		this.helpProvider = new HelpProvider(options);
		this.aliasProvider = new AliasProvider(options);
		this.packageManager = new PackageManager({...options, rHelp: this});
		this.treeViewWrapper = new HelpTreeWrapper(this);
		this.helpPanelOptions = options;
	}

	// used to close files, stop servers etc.
	public dispose(): void {
		const children = [
			this.helpProvider,
			this.aliasProvider,
			this.packageManager,
			this.treeViewWrapper,
			...this.helpPanels
		];
		for(const child of children){
			if(child && 'dispose' in child && typeof child.dispose === 'function'){
				try{
					child.dispose();
				} catch(e) {}
			}
		}
	}

	// refresh cached help info
	public refresh(): boolean {
		this.cachedHelpFiles.clear();
		if(this.helpProvider?.refresh){
			this.helpProvider.refresh();
		}
		if(this.aliasProvider?.refresh){
			this.aliasProvider.refresh();
		}
		if(this.packageManager?.refresh){
			this.packageManager.refresh();
		}
		return true;
	}

	// refresh cached help info only for a specific file/package
	public clearCachedFiles(re: string|RegExp): void {
		for(const path of this.cachedHelpFiles.keys()){
			if(
				(typeof re === 'string' && path === re)
				|| (typeof re !== 'string' && re.exec(path))
			){
				this.cachedHelpFiles.delete(path);
			}
		}
	}


	// create a new help panel
	public makeNewHelpPanel(): HelpPanel {
		const helpPanel = new HelpPanel(this.helpPanelOptions, this);
		this.helpPanels.unshift(helpPanel);
		return helpPanel;
	}

	// return the active help panel
	// if no help panel is active and fallBack==true, the newest help panel is returned
	// (or a new one created)
	public getActiveHelpPanel(): HelpPanel;
	public getActiveHelpPanel(fallBack?: boolean): HelpPanel | undefined;
	public getActiveHelpPanel(fallBack: boolean = true): HelpPanel | undefined {
		for(const helpPanel of this.helpPanels){
			if(helpPanel.panel && helpPanel.panel.active){
				return helpPanel;
			}
		}
		if(fallBack){
			return this.getNewestHelpPanel();
		}
		return undefined;
	}

	// return the newest help panel
	// if no help panel is available and createNewPanel==true, a new panel is created
	public getNewestHelpPanel(): HelpPanel;
	public getNewestHelpPanel(createNewPanel: boolean): HelpPanel | undefined;
	public getNewestHelpPanel(createNewPanel: boolean = true): HelpPanel | undefined {
		if(this.helpPanels.length){
			return this.helpPanels[0];
		} else if(createNewPanel){
			return this.makeNewHelpPanel();
		} else{
			return undefined;
		}
	}

	// Triggered by a command button shown above the helppanel
	public openExternal(): void {
		void this.getActiveHelpPanel(false)?.openInExternalBrowser();
	}

	// go back/forward in the history of the webview
	public goBack(): void{
		this.getActiveHelpPanel(false)?.goBack();
	}
	public goForward(): void{
		this.getActiveHelpPanel(false)?.goForward();
	}

	// Shows the content of the tree-view in a quickpick
	public showHelpMenu(): void  {
		void this.treeViewWrapper.helpViewProvider.rootItem.showQuickPick();
	}

	// search function, similar to typing `?? ...` in R
	public async searchHelpByText(): Promise<boolean>{
		const searchTerm = await vscode.window.showInputBox({
			value: '',
			prompt: 'Please enter a search term'
		});
		if(searchTerm !== undefined){
			return this.showHelpForPath(`/doc/html/Search?pattern=${searchTerm}`);
		}
		return false;
	}

	// search function, similar to calling `?` in R
	public async searchHelpByAlias(): Promise<boolean> {

		const aliases = await doWithProgress(() => this.aliasProvider.getAllAliases());

		if(!aliases){
			void vscode.window.showErrorMessage('Failed to get list of R functions. Make sure that `jsonlite` is installed and r.helpPanel.rpath points to a valid R executable.');
			return false;
		}
		const qpItems: (vscode.QuickPickItem & Alias)[] = aliases.map(v => {
			return {
				...v,
				label: v.name,
				description: `(${v.package}::${v.name})`,
			};
		});
		const qpOptions = {
			matchOnDescription: true,
			placeHolder: 'Please type a function name/documentation entry'
		};
		const qp = await vscode.window.showQuickPick(
			qpItems,
			qpOptions
		);
		if(qp){
			return this.showHelpForPath(`/library/${qp.package}/html/${qp.alias}.html`);
		}
		return false;
	}

	// shows help for request path as used by R's internal help server
	public async showHelpForPath(requestPath: string, viewer?: string|any): Promise<boolean> {

		// get and show helpFile
		// const helpFile = this.helpProvider.getHelpFileFromRequestPath(requestPath);
		const helpFile = await this.getHelpFileForPath(requestPath);
		if(helpFile){
			return this.showHelpFile(helpFile, viewer);
		} else{
			const msg = `Couldn't show help for path:\n${requestPath}\n`;
			void vscode.window.showErrorMessage(msg);
			return false;
		}
	}

	public async getHelpFileForPath(requestPath: string, modify: boolean = true): Promise<HelpFile | null> {
		// get helpFile from helpProvider if not cached
		if(!this.cachedHelpFiles.has(requestPath)){
			const helpFile = await this.helpProvider.getHelpFileFromRequestPath(requestPath);
			this.cachedHelpFiles.set(requestPath, helpFile);
		}

		// modify the helpFile (syntax highlighting etc.)
		// modifications are optional and cached
		const helpFileCached = this.cachedHelpFiles.get(requestPath);
		if(!helpFileCached){
			return null;
		} else if(modify && !helpFileCached.isModified){
			this.pimpMyHelp(helpFileCached);
		}

		// make deep copy to avoid messing with cache
		const helpFile = {
			...helpFileCached
		};

		return helpFile;
	}

	// shows (internal) help file object in webview
	private async showHelpFile(helpFile: HelpFile|Promise<HelpFile>, viewer?: string|any): Promise<boolean>{
		return await this.getNewestHelpPanel().showHelpFile(helpFile, undefined, undefined, viewer);
	}


	// improves the help display by applying syntax highlighting and adjusting hyperlinks
	// only contains modifications that are independent of the webview panel
	// (i.e. no modified file paths, scroll position etc.)
	private pimpMyHelp(helpFile: HelpFile): HelpFile {

		// Retun if the help file is already modified
		if(helpFile.isModified){
			return helpFile;
		}

		// store original html content
		helpFile.html0 = helpFile.html;

		// Make sure the helpfile content is actually html
		const re = new RegExp('<html[^\\n]*>.*</html>', 'ms');
		helpFile.isHtml = !!re.exec(helpFile.html);
		if(!helpFile.isHtml){
			const html = escapeHtml(helpFile.html);
			helpFile.html = `<html><head></head><body><pre>${html}</pre></body></html>`;
		}

		// parse the html string
		const $ = cheerio.load(helpFile.html);

		// Remove style elements specified in the html itself (replaced with custom CSS)
		$('head style').remove();

		// Apply syntax highlighting:
		if(config().get<boolean>('helpPanel.enableSyntaxHighlighting')){
			// find all code sections, enclosed by <pre>...</pre>
			const codeSections = $('pre');

			// apply syntax highlighting to each code section:
			codeSections.each((i, section) => {
				const styledCode = hljs.highlight('r', $(section).text() || '');
				$(section).html(styledCode.value);
			});
		}

		// replace html of the helpfile
		helpFile.html = $.html();

		// flag help file as modified
		helpFile.isModified = true;

		return helpFile;
	}
}

// Helper function used to convert raw text files to html
function escapeHtml(source: string) {
	const entityMap = new Map<string, string>(Object.entries({
		'&': '&amp;',
		'<': '&lt;',
		'>': '&gt;',
		'"': '&quot;',
		'\'': '&#39;',
		'/': '&#x2F;'
	}));
    return String(source).replace(/[&<>"'/]/g, (s: string) => entityMap.get(s) || '');
}
