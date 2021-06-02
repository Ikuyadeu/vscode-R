import * as vscode from 'vscode';
import * as vsls from 'vsls';
import * as fs from 'fs-extra';

import { enableSessionWatcher, extensionContext } from '../extension';
import { attachActiveGuest, browserDisposables, initGuest } from './shareSession';
import { initTreeView, rLiveShareProvider, shareWorkspace, ToggleNode } from './shareTree';
import { Commands, Callback, onRequest, request } from './shareCommands';
import { HelpFile } from '../rHelp';
import { globalenv } from '../session';
import { config } from '../util';

/// LiveShare
export let rHostService: HostService = undefined;
export let rGuestService: GuestService = undefined;
export let liveSession: vsls.LiveShare;
export let isGuestSession: boolean;
export let _sessionStatusBarItem: vscode.StatusBarItem;
const disposables: vscode.Disposable[] = [];

// service vars
export const ShareProviderName = 'vscode-r';
export let service: vsls.SharedServiceProxy | vsls.SharedService | null = undefined;

// random number to fake a UUID for differentiating between
// host calls and guest calls (specifically for the workspace
// viewer 'View' function)
export const UUID = Math.floor(Math.random() * Date.now());

/// state-tracking bools
// Bool to check if live share is loaded and active
export function isLiveShare(): boolean {
    const shareStarted = liveSession?.session?.id;
    // If there is a hosted session*, return true
    // else return false
    // * using vsls.getApi() instead of vsls.getApi().session.id
    // * will always return true, even if a session is not active
    // * (a session id will only exist if a session is active)
    return !!shareStarted;
}

export function isGuest(): boolean {
    if (isLiveShare()) {
        return liveSession.session.role === vsls.Role.Guest;
    } else {
        return false;
    }
}

export function isHost(): boolean {
    if (isLiveShare()) {
        return liveSession.session.role === vsls.Role.Host;
    } else {
        return false;
    }
}

// Initialises the Liveshare functionality for host & guest
// * session watcher is required *
export async function initLiveShare(context: vscode.ExtensionContext): Promise<void> {
    if (enableSessionWatcher) {
        await LiveSessionListener();
        isGuestSession = isGuest();
        if (!isGuestSession) {
            // Construct tree view for host
            initTreeView();
        } else {
            // Construct guest session watcher
            initGuest(context);
        }

        // Set context value for hiding buttons for guests
        void vscode.commands.executeCommand('setContext', 'r.liveShare:isGuest', isGuestSession);

        // push commands
        if (!isGuestSession) {
            context.subscriptions.push(
                vscode.commands.registerCommand(
                    'r.liveShare.toggle', (node: ToggleNode) => node.toggle(rLiveShareProvider)
                ),
                vscode.commands.registerCommand(
                    'r.liveShare.retry', async () => await LiveSessionListener()
                )
            );
        } else {
            context.subscriptions.push(
                vscode.commands.registerCommand('r.attachActiveGuest', () => attachActiveGuest())
            );
        }
    }
}

// Listens for the activation of a LiveShare session
export async function LiveSessionListener(): Promise<void> {
    rHostService = new HostService;
    rGuestService = new GuestService;

    // Return out when the vsls extension isn't
    // installed/available
    const liveSessionStatus = await Promise.race([
        vsls.getApi(),
        new Promise((res) => setTimeout(() => res(null), config().get<number>('liveShare.timeout')))
    ]);

    void vscode.commands.executeCommand('setContext', 'r.liveShare:aborted', !liveSessionStatus);

    if (!liveSessionStatus) {
        console.log('[LiveSessionListener] aborted');
        return;
    }

    liveSession = liveSessionStatus as vsls.LiveShare;
    console.log('[LiveSessionListener] started');

    // When the session state changes, attempt to
    // start a liveSession service, which is responsible
    // for providing session-watcher functionality
    // to guest sessions
    liveSession.onDidChangeSession(async (e: vsls.SessionChangeEvent) => {
        switch (e.session.role) {
            case vsls.Role.None:
                console.log('[LiveSessionListener] end event');
                await sessionCleanup();
                break;
            case vsls.Role.Guest:
                console.log('[LiveSessionListener] guest event');
                await rGuestService.startService();
                break;
            case vsls.Role.Host:
                console.log('[LiveSessionListener] host event');
                await rHostService.startService();
                rLiveShareProvider.refresh();
                break;
            default:
                console.log('[LiveSessionListener] default case');
                break;
        }
    }, null, extensionContext.subscriptions);

    // onDidChangeSession seems to only activate when the host joins/leaves,
    // or roles are changed somehow - may be a regression in API,
    // this is a workaround for the time being
    switch (liveSession.session.role) {
        case vsls.Role.None:
            break;
        case vsls.Role.Guest:
            console.log('[LiveSessionListener] guest event');
            await rGuestService.startService();
            break;
        default:
            console.log('[LiveSessionListener] host event');
            await rHostService.startService();
            break;
    }
}

// Communication between the HostService and the GuestService
// typically falls under 2 communication paths (there are exceptions):
//
// 1. a function on the HostService is called, which pushes
// an event (notify), which is picked up by a callback (onNotify)
// e.g. rHostService.notifyRequest
//
// 2. a function on the GuestService is called, which pushes a
// request to the HostService, which is picked up the HostService
// callback and * returned * to the GuestService
// e.g. rGuestService.requestFileContent
export class HostService {
    private _isStarted: boolean = false;
    // Service state getter
    public isStarted(): boolean {
        return this._isStarted;
    }
    public async startService(): Promise<void> {
        // Provides core liveshare functionality
        // The shared service is used as a RPC service
        // to pass messages between the host and guests
        service = await liveSession.shareService(ShareProviderName);
        if (service) {
            this._isStarted = true;
            for (const command in Commands.host) {
                void onRequest(command, Commands.host[command], service);
                console.log(`[HostService] added ${command} callback`);
            }
        } else {
            console.error('[HostService] service activation failed');
        }
    }
    public async stopService(): Promise<void> {
        await liveSession.unshareService(ShareProviderName);
        service = null;
        this._isStarted = false;
    }
    /// Session Syncing ///
    // These are called from the host in order to tell the guest session
    // to update the env/request/plot
    // This way, we don't have to re-create a guest version of the session
    // watcher, and can rely on the host to tell when something needs to be
    // updated
    public notifyGlobalenv(hostEnv: string): void {
        if (this._isStarted && shareWorkspace) {
            void request(Callback.NotifyEnvUpdate, hostEnv);
        }
    }
    public notifyRequest(file: string, force: boolean = false): void {
        if (this._isStarted && shareWorkspace) {
            void request(Callback.NotifyRequestUpdate, file, force);
            void this.notifyGlobalenv(globalenv);
        }
    }
    public notifyPlot(file: string): void {
        if (this._isStarted && shareWorkspace) {
            void request(Callback.NotifyPlotUpdate, file);
        }
    }
    public orderGuestDetach(): void {
        if (this._isStarted) {
            void request(Callback.OrderDetach);
        }
    }
}

export class GuestService {
    private _isStarted: boolean = false;
    public isStarted(): boolean {
        return this._isStarted;
    }
    public async startService(): Promise<void> {
        service = await liveSession.getSharedService(ShareProviderName);
        if (service) {
            this._isStarted = true;
            this.requestAttach();
            for (const command in Commands.guest) {
                void onRequest(command, Commands.guest[command], service);
                console.log(`[GuestService] added ${command} callback`);
            }
        } else {
            console.error('[GuestService] service request failed');
        }
    }
    public setStatusBarItem(sessionStatusBarItem: vscode.StatusBarItem): void {
        _sessionStatusBarItem = sessionStatusBarItem;
    }
    // The guest requests the host returns the attach specifications to the guest
    // This ensures that guests without read/write access can still view the
    // R workspace
    public requestAttach(): void {
        if (this._isStarted) {
            void request(Callback.RequestAttachGuest);
            // focus guest term
            const rTermNameOptions = ['R [Shared]', 'R Interactive [Shared]'];
            const activeTerminalName = vscode.window.activeTerminal.name;
            if (!rTermNameOptions.includes(activeTerminalName)) {
                for (const [i] of vscode.window.terminals.entries()) {
                    const terminal = vscode.window.terminals[i];
                    const terminalName = terminal.name;
                    if (rTermNameOptions.includes(terminalName)) {
                        terminal.show(true);
                    }
                }
            }
        }
    }
    // Used to ensure that the guest can run workspace viewer commands
    // e.g.view, remove, clean
    // * Permissions are handled host-side
    public requestRunTextInTerm(text: string): void {
        if (this._isStarted) {
            void request(Callback.RequestRunTextInTerm, text);
        }
    }
    // The session watcher relies on files for providing many functions to vscode-R.
    // As LiveShare does not allow for exposing files outside a given workspace,
    // the guest must rely on the host sending the content of a given file, in place
    // of having their own /tmp/ files*
    // * in some cases, creating a file on the guest side is necessary,
    // * such as dataview files or plot images
    public async requestFileContent(file: fs.PathLike | number): Promise<Buffer>;
    public async requestFileContent(file: fs.PathLike | number, encoding: string): Promise<string>;
    public async requestFileContent(file: fs.PathLike | number, encoding?: string): Promise<string | Buffer> {
        if (this._isStarted) {
            if (encoding !== undefined) {
                const content: string | unknown = await request(Callback.GetFileContent, file, encoding);
                if (typeof content === 'string') {
                    return content;
                } else {
                    console.error('[GuestService] failed to retrieve file content (not of type "string")');
                }
            } else {
                const content: Buffer | unknown = await request(Callback.GetFileContent, file);
                if (content) {
                    return content as Buffer;
                } else {
                    console.error('[GuestService] failed to retrieve file content (not of type "Buffer")');
                }
            }
        }
    }

    public async requestHelpContent(file: string): Promise<HelpFile> {
        const content: string | null | unknown = await request(Callback.GetHelpFileContent, file);
        if (content) {
            return content as HelpFile;
        }
    }
}

// Clear up any listeners & disposables, so that vscode-R
// isn't slowed down if liveshare is ended
// This is used instead of relying on context disposables,
// as an R session can continue even when liveshare is ended
async function sessionCleanup(): Promise<void> {
    if (rHostService.isStarted()) {
        console.log('[HostService] stopping service');
        await rHostService.stopService();
        for (const disposable of browserDisposables) {
            console.log(`[HostService] disposing of browser ${disposable.url}`);
            disposable.Disposable.dispose();
        }
        rLiveShareProvider.refresh();
    }

    for (const disposable of disposables) {
        disposable.dispose();
    }
}