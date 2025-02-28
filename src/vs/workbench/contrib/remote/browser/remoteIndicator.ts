/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from 'vs/nls';
import { STATUS_BAR_HOST_NAME_BACKGROUND, STATUS_BAR_HOST_NAME_FOREGROUND } from 'vs/workbench/common/theme';
import { themeColorFromId } from 'vs/platform/theme/common/themeService';
import { IRemoteAgentService } from 'vs/workbench/services/remote/common/remoteAgentService';
import { Disposable, dispose } from 'vs/base/common/lifecycle';
import { MenuId, IMenuService, MenuItemAction, MenuRegistry, registerAction2, Action2, SubmenuItemAction } from 'vs/platform/actions/common/actions';
import { IWorkbenchContribution } from 'vs/workbench/common/contributions';
import { StatusbarAlignment, IStatusbarService, IStatusbarEntryAccessor, IStatusbarEntry } from 'vs/workbench/services/statusbar/browser/statusbar';
import { ILabelService } from 'vs/platform/label/common/label';
import { ContextKeyExpr, IContextKeyService, RawContextKey } from 'vs/platform/contextkey/common/contextkey';
import { ICommandService } from 'vs/platform/commands/common/commands';
import { Schemas } from 'vs/base/common/network';
import { IExtensionService } from 'vs/workbench/services/extensions/common/extensions';
import { QuickPickItem, IQuickInputService, IQuickPickItem } from 'vs/platform/quickinput/common/quickInput';
import { IBrowserWorkbenchEnvironmentService } from 'vs/workbench/services/environment/browser/environmentService';
import { PersistentConnectionEventType } from 'vs/platform/remote/common/remoteAgentConnection';
import { IRemoteAuthorityResolverService } from 'vs/platform/remote/common/remoteAuthorityResolver';
import { IHostService } from 'vs/workbench/services/host/browser/host';
import { isWeb } from 'vs/base/common/platform';
import { once } from 'vs/base/common/functional';
import { truncate } from 'vs/base/common/strings';
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';
import { getRemoteName } from 'vs/platform/remote/common/remoteHosts';
import { getVirtualWorkspaceLocation } from 'vs/platform/workspace/common/virtualWorkspace';
import { getCodiconAriaLabel } from 'vs/base/common/iconLabels';
import { ILogService } from 'vs/platform/log/common/log';
import { ReloadWindowAction } from 'vs/workbench/browser/actions/windowActions';
import { IExtensionGalleryService } from 'vs/platform/extensionManagement/common/extensionManagement';
import { LIST_WORKSPACE_UNSUPPORTED_EXTENSIONS_COMMAND_ID } from 'vs/workbench/contrib/extensions/common/extensions';
import { ServicesAccessor } from 'vs/platform/instantiation/common/instantiation';
import { IMarkdownString, MarkdownString } from 'vs/base/common/htmlContent';
import { RemoteNameContext, VirtualWorkspaceContext } from 'vs/workbench/common/contextkeys';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { WorkbenchActionExecutedClassification, WorkbenchActionExecutedEvent } from 'vs/base/common/actions';
import { KeybindingWeight } from 'vs/platform/keybinding/common/keybindingsRegistry';
import { KeyCode, KeyMod } from 'vs/base/common/keyCodes';
import { IProductService } from 'vs/platform/product/common/productService';
import { IProgressService, ProgressLocation } from 'vs/platform/progress/common/progress';
import { ThemeIcon } from 'vs/base/common/themables';
import { Codicon } from 'vs/base/common/codicons';

type ActionGroup = [string, Array<MenuItemAction | SubmenuItemAction>];
export class RemoteStatusIndicator extends Disposable implements IWorkbenchContribution {

	private static readonly REMOTE_ACTIONS_COMMAND_ID = 'workbench.action.remote.showMenu';
	private static readonly CLOSE_REMOTE_COMMAND_ID = 'workbench.action.remote.close';
	private static readonly SHOW_CLOSE_REMOTE_COMMAND_ID = !isWeb; // web does not have a "Close Remote" command
	private static readonly INSTALL_REMOTE_EXTENSIONS_ID = 'workbench.action.remote.extensions';

	private static readonly REMOTE_STATUS_LABEL_MAX_LENGTH = 40;

	private remoteStatusEntry: IStatusbarEntryAccessor | undefined;

	private readonly legacyIndicatorMenu = this._register(this.menuService.createMenu(MenuId.StatusBarWindowIndicatorMenu, this.contextKeyService)); // to be removed once migration completed
	private readonly remoteIndicatorMenu = this._register(this.menuService.createMenu(MenuId.StatusBarRemoteIndicatorMenu, this.contextKeyService));

	private remoteMenuActionsGroups: ActionGroup[] | undefined;

	private readonly remoteAuthority = this.environmentService.remoteAuthority;

	private virtualWorkspaceLocation: { scheme: string; authority: string } | undefined = undefined;

	private connectionState: 'initializing' | 'connected' | 'reconnecting' | 'disconnected' | undefined = undefined;
	private readonly connectionStateContextKey = new RawContextKey<'' | 'initializing' | 'disconnected' | 'connected'>('remoteConnectionState', '').bindTo(this.contextKeyService);

	private loggedInvalidGroupNames: { [group: string]: boolean } = Object.create(null);

	private readonly recommendedExtensions = new Set<string>();
	private extensionsToInstall = new Map<string, string>();

	constructor(
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IBrowserWorkbenchEnvironmentService private readonly environmentService: IBrowserWorkbenchEnvironmentService,
		@ILabelService private readonly labelService: ILabelService,
		@IContextKeyService private contextKeyService: IContextKeyService,
		@IMenuService private menuService: IMenuService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@ICommandService private readonly commandService: ICommandService,
		@IExtensionService private readonly extensionService: IExtensionService,
		@IRemoteAgentService private readonly remoteAgentService: IRemoteAgentService,
		@IRemoteAuthorityResolverService private readonly remoteAuthorityResolverService: IRemoteAuthorityResolverService,
		@IHostService private readonly hostService: IHostService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
		@IExtensionGalleryService private readonly extensionGalleryService: IExtensionGalleryService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IProductService private readonly productService: IProductService,
	) {
		super();

		// Set initial connection state
		if (this.remoteAuthority) {
			this.connectionState = 'initializing';
			this.connectionStateContextKey.set(this.connectionState);
		} else {
			this.updateVirtualWorkspaceLocation();
		}

		this.registerActions();
		this.registerListeners();

		this.updateWhenInstalledExtensionsRegistered();
		this.updateRemoteStatusIndicator();
	}

	private registerActions(): void {
		const category = { value: nls.localize('remote.category', "Remote"), original: 'Remote' };

		// Show Remote Menu
		const that = this;
		registerAction2(class extends Action2 {
			constructor() {
				super({
					id: RemoteStatusIndicator.REMOTE_ACTIONS_COMMAND_ID,
					category,
					title: { value: nls.localize('remote.showMenu', "Show Remote Menu"), original: 'Show Remote Menu' },
					f1: true,
					keybinding: {
						weight: KeybindingWeight.WorkbenchContrib,
						primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyO,
					}
				});
			}
			run = () => that.showRemoteMenu();
		});

		// Close Remote Connection
		if (RemoteStatusIndicator.SHOW_CLOSE_REMOTE_COMMAND_ID) {
			registerAction2(class extends Action2 {
				constructor() {
					super({
						id: RemoteStatusIndicator.CLOSE_REMOTE_COMMAND_ID,
						category,
						title: { value: nls.localize('remote.close', "Close Remote Connection"), original: 'Close Remote Connection' },
						f1: true,
						precondition: ContextKeyExpr.or(RemoteNameContext, VirtualWorkspaceContext)
					});
				}
				run = () => that.hostService.openWindow({ forceReuseWindow: true, remoteAuthority: null });
			});
			if (this.remoteAuthority) {
				MenuRegistry.appendMenuItem(MenuId.MenubarFileMenu, {
					group: '6_close',
					command: {
						id: RemoteStatusIndicator.CLOSE_REMOTE_COMMAND_ID,
						title: nls.localize({ key: 'miCloseRemote', comment: ['&& denotes a mnemonic'] }, "Close Re&&mote Connection")
					},
					order: 3.5
				});
			}
		}

		if (this.extensionGalleryService.isEnabled()) {
			const that = this;
			registerAction2(class extends Action2 {
				constructor() {
					super({
						id: RemoteStatusIndicator.INSTALL_REMOTE_EXTENSIONS_ID,
						category,
						// Only show this if there are missing remotes
						title: { value: nls.localize('remote.install', "Install Remote Development Extensions"), original: 'Install Remote Development Extensions' },
						f1: true
					});
				}
				run = (accessor: ServicesAccessor, input: string) => {
					const commandService = accessor.get(ICommandService);
					const quickInputService = accessor.get(IQuickInputService);
					const progressService = accessor.get(IProgressService);

					const items: (IQuickPickItem & { extensionId: string })[] = [];
					for (const [extensionId, label] of that.extensionsToInstall.entries()) {
						items.push({ label, extensionId, buttons: [{ tooltip: nls.localize('remote.install.info', 'View Extension Description'), iconClass: ThemeIcon.asClassName(Codicon.info) }] });
					}
					items.sort((a, b) => a.label.localeCompare(b.label));

					const quickPick = quickInputService.createQuickPick<IQuickPickItem & { extensionId: string }>();
					quickPick.items = items;
					quickPick.placeholder = nls.localize('remote.install.placeholder', "Select remote extensions to install");
					quickPick.canSelectMany = true;
					quickPick.selectedItems = items;
					quickPick.ignoreFocusOut = true;
					quickPick.onDidTriggerItemButton(e => {
						commandService.executeCommand('extension.open', e.item.extensionId);
					});
					quickPick.onDidAccept(async () => {
						try {
							for (const item of quickPick.selectedItems) {
								await progressService.withProgress(
									{
										location: ProgressLocation.Notification,
										title: nls.localize("remote.install.progress", "Installing the {0} extension...", item.label),
									},
									async () => commandService.executeCommand('workbench.extensions.installExtension', item.extensionId)
								);
							}
						} finally {
							quickPick.dispose();
						}
					});
					quickPick.show();
				};
			});
		}
	}

	private registerListeners(): void {

		// Menu changes
		const updateRemoteActions = () => {
			this.remoteMenuActionsGroups = undefined;
			this.updateRemoteStatusIndicator();
		};

		this._register(this.legacyIndicatorMenu.onDidChange(updateRemoteActions));
		this._register(this.remoteIndicatorMenu.onDidChange(updateRemoteActions));

		// Update indicator when formatter changes as it may have an impact on the remote label
		this._register(this.labelService.onDidChangeFormatters(() => this.updateRemoteStatusIndicator()));

		// Update based on remote indicator changes if any
		const remoteIndicator = this.environmentService.options?.windowIndicator;
		if (remoteIndicator && remoteIndicator.onDidChange) {
			this._register(remoteIndicator.onDidChange(() => this.updateRemoteStatusIndicator()));
		}

		// Listen to changes of the connection
		if (this.remoteAuthority) {
			const connection = this.remoteAgentService.getConnection();
			if (connection) {
				this._register(connection.onDidStateChange((e) => {
					switch (e.type) {
						case PersistentConnectionEventType.ConnectionLost:
						case PersistentConnectionEventType.ReconnectionRunning:
						case PersistentConnectionEventType.ReconnectionWait:
							this.setState('reconnecting');
							break;
						case PersistentConnectionEventType.ReconnectionPermanentFailure:
							this.setState('disconnected');
							break;
						case PersistentConnectionEventType.ConnectionGain:
							this.setState('connected');
							break;
					}
				}));
			}
		} else {
			this._register(this.workspaceContextService.onDidChangeWorkbenchState(() => {
				this.updateVirtualWorkspaceLocation();
				this.updateRemoteStatusIndicator();
			}));
		}

		this._register(this.extensionService.onDidChangeExtensions((e) => {
			e.added.forEach((extensionIdentifier) => {
				const id = extensionIdentifier.id?.toLowerCase();
				if (id && this.recommendedExtensions.has(id)) {
					this.extensionsToInstall.delete(id);
				}
			});
			e.removed.forEach((extensionIdentifier) => {
				let { id, displayName } = extensionIdentifier;
				id = id?.toLowerCase();
				if (id && displayName && this.recommendedExtensions.has(id)) {
					this.extensionsToInstall.set(id, displayName);
				}
			});
		}));
	}

	private updateVirtualWorkspaceLocation() {
		this.virtualWorkspaceLocation = getVirtualWorkspaceLocation(this.workspaceContextService.getWorkspace());
	}

	private async updateWhenInstalledExtensionsRegistered(): Promise<void> {
		await this.extensionService.whenInstalledExtensionsRegistered();

		const remoteAuthority = this.remoteAuthority;
		if (remoteAuthority) {

			// Try to resolve the authority to figure out connection state
			(async () => {
				try {
					await this.remoteAuthorityResolverService.resolveAuthority(remoteAuthority);

					this.setState('connected');
				} catch (error) {
					this.setState('disconnected');
				}
			})();
		}

		const extensionTips = { ...this.productService.remoteExtensionTips, ...this.productService.virtualWorkspaceExtensionTips };
		for (const [_, extension] of Object.entries(extensionTips)) {
			let { extensionId, friendlyName } = extension;
			extensionId = extensionId.toLowerCase();
			this.recommendedExtensions.add(extensionId);
			if (!this.extensionService.extensions.some((extension) => extension.id?.toLowerCase() === extensionId)) {
				this.extensionsToInstall.set(extensionId, friendlyName);
			}
		}

		this.updateRemoteStatusIndicator();
	}

	private setState(newState: 'disconnected' | 'connected' | 'reconnecting'): void {
		if (this.connectionState !== newState) {
			this.connectionState = newState;

			// simplify context key which doesn't support `connecting`
			if (this.connectionState === 'reconnecting') {
				this.connectionStateContextKey.set('disconnected');
			} else {
				this.connectionStateContextKey.set(this.connectionState);
			}

			this.updateRemoteStatusIndicator();
		}
	}

	private validatedGroup(group: string) {
		if (!group.match(/^(remote|virtualfs)_(\d\d)_(([a-z][a-z0-9+.-]*)_(.*))$/)) {
			if (!this.loggedInvalidGroupNames[group]) {
				this.loggedInvalidGroupNames[group] = true;
				this.logService.warn(`Invalid group name used in "statusBar/remoteIndicator" menu contribution: ${group}. Entries ignored. Expected format: 'remote_$ORDER_$REMOTENAME_$GROUPING or 'virtualfs_$ORDER_$FILESCHEME_$GROUPING.`);
			}
			return false;
		}
		return true;
	}

	private getRemoteMenuActions(doNotUseCache?: boolean): ActionGroup[] {
		if (!this.remoteMenuActionsGroups || doNotUseCache) {
			this.remoteMenuActionsGroups = this.remoteIndicatorMenu.getActions().filter(a => this.validatedGroup(a[0])).concat(this.legacyIndicatorMenu.getActions());
		}
		return this.remoteMenuActionsGroups;
	}

	private updateRemoteStatusIndicator(): void {

		// Remote Indicator: show if provided via options, e.g. by the web embedder API
		const remoteIndicator = this.environmentService.options?.windowIndicator;
		if (remoteIndicator) {
			this.renderRemoteStatusIndicator(truncate(remoteIndicator.label, RemoteStatusIndicator.REMOTE_STATUS_LABEL_MAX_LENGTH), remoteIndicator.tooltip, remoteIndicator.command);
			return;
		}

		// Show for remote windows on the desktop, but not when in code server web
		if (this.remoteAuthority && (!isWeb || this.environmentService.options?.webSocketFactory)) {
			const hostLabel = this.labelService.getHostLabel(Schemas.vscodeRemote, this.remoteAuthority) || this.remoteAuthority;
			switch (this.connectionState) {
				case 'initializing':
					this.renderRemoteStatusIndicator(nls.localize('host.open', "Opening Remote..."), nls.localize('host.open', "Opening Remote..."), undefined, true /* progress */);
					break;
				case 'reconnecting':
					this.renderRemoteStatusIndicator(`${nls.localize('host.reconnecting', "Reconnecting to {0}...", truncate(hostLabel, RemoteStatusIndicator.REMOTE_STATUS_LABEL_MAX_LENGTH))}`, undefined, undefined, true);
					break;
				case 'disconnected':
					this.renderRemoteStatusIndicator(`$(alert) ${nls.localize('disconnectedFrom', "Disconnected from {0}", truncate(hostLabel, RemoteStatusIndicator.REMOTE_STATUS_LABEL_MAX_LENGTH))}`);
					break;
				default: {
					const tooltip = new MarkdownString('', { isTrusted: true, supportThemeIcons: true });
					const hostNameTooltip = this.labelService.getHostTooltip(Schemas.vscodeRemote, this.remoteAuthority);
					if (hostNameTooltip) {
						tooltip.appendMarkdown(hostNameTooltip);
					} else {
						tooltip.appendText(nls.localize({ key: 'host.tooltip', comment: ['{0} is a remote host name, e.g. Dev Container'] }, "Editing on {0}", hostLabel));
					}
					this.renderRemoteStatusIndicator(`$(remote) ${truncate(hostLabel, RemoteStatusIndicator.REMOTE_STATUS_LABEL_MAX_LENGTH)}`, tooltip);
				}
			}
			return;
		}
		// Show when in a virtual workspace
		if (this.virtualWorkspaceLocation) {
			// Workspace with label: indicate editing source
			const workspaceLabel = this.labelService.getHostLabel(this.virtualWorkspaceLocation.scheme, this.virtualWorkspaceLocation.authority);
			if (workspaceLabel) {
				const tooltip = new MarkdownString('', { isTrusted: true, supportThemeIcons: true });
				const hostNameTooltip = this.labelService.getHostTooltip(this.virtualWorkspaceLocation.scheme, this.virtualWorkspaceLocation.authority);
				if (hostNameTooltip) {
					tooltip.appendMarkdown(hostNameTooltip);
				} else {
					tooltip.appendText(nls.localize({ key: 'workspace.tooltip', comment: ['{0} is a remote workspace name, e.g. GitHub'] }, "Editing on {0}", workspaceLabel));
				}
				if (!isWeb || this.remoteAuthority) {
					tooltip.appendMarkdown('\n\n');
					tooltip.appendMarkdown(nls.localize(
						{ key: 'workspace.tooltip2', comment: ['[features are not available]({1}) is a link. Only translate `features are not available`. Do not change brackets and parentheses or {0}'] },
						"Some [features are not available]({0}) for resources located on a virtual file system.",
						`command:${LIST_WORKSPACE_UNSUPPORTED_EXTENSIONS_COMMAND_ID}`
					));
				}
				this.renderRemoteStatusIndicator(`$(remote) ${truncate(workspaceLabel, RemoteStatusIndicator.REMOTE_STATUS_LABEL_MAX_LENGTH)}`, tooltip);
				return;
			}
		}
		// Show when there are commands other than the 'install additional remote extensions' command.
		if (this.hasRemoteMenuCommands(true)) {
			this.renderRemoteStatusIndicator(`$(remote)`, nls.localize('noHost.tooltip', "Open a Remote Window"));
			return;
		}

		// No Remote Extensions: hide status indicator
		dispose(this.remoteStatusEntry);
		this.remoteStatusEntry = undefined;
	}

	private renderRemoteStatusIndicator(text: string, tooltip?: string | IMarkdownString, command?: string, showProgress?: boolean): void {
		const name = nls.localize('remoteHost', "Remote Host");
		if (typeof command !== 'string' && (this.hasRemoteMenuCommands(false))) {
			command = RemoteStatusIndicator.REMOTE_ACTIONS_COMMAND_ID;
		}

		const ariaLabel = getCodiconAriaLabel(text);
		const properties: IStatusbarEntry = {
			name,
			backgroundColor: themeColorFromId(STATUS_BAR_HOST_NAME_BACKGROUND),
			color: themeColorFromId(STATUS_BAR_HOST_NAME_FOREGROUND),
			ariaLabel,
			text,
			showProgress,
			tooltip,
			command
		};

		if (this.remoteStatusEntry) {
			this.remoteStatusEntry.update(properties);
		} else {
			this.remoteStatusEntry = this.statusbarService.addEntry(properties, 'status.host', StatusbarAlignment.LEFT, Number.MAX_VALUE /* first entry */);
		}
	}

	private showRemoteMenu() {
		const getCategoryLabel = (action: MenuItemAction) => {
			if (action.item.category) {
				return typeof action.item.category === 'string' ? action.item.category : action.item.category.value;
			}
			return undefined;
		};

		const matchCurrentRemote = () => {
			if (this.remoteAuthority) {
				return new RegExp(`^remote_\\d\\d_${getRemoteName(this.remoteAuthority)}_`);
			} else if (this.virtualWorkspaceLocation) {
				return new RegExp(`^virtualfs_\\d\\d_${this.virtualWorkspaceLocation.scheme}_`);
			}
			return undefined;
		};

		const computeItems = () => {
			let actionGroups = this.getRemoteMenuActions(true);

			const items: QuickPickItem[] = [];

			const currentRemoteMatcher = matchCurrentRemote();
			if (currentRemoteMatcher) {
				// commands for the current remote go first
				actionGroups = actionGroups.sort((g1, g2) => {
					const isCurrentRemote1 = currentRemoteMatcher.test(g1[0]);
					const isCurrentRemote2 = currentRemoteMatcher.test(g2[0]);
					if (isCurrentRemote1 !== isCurrentRemote2) {
						return isCurrentRemote1 ? -1 : 1;
					}
					return g1[0].localeCompare(g2[0]);
				});
			}

			let lastCategoryName: string | undefined = undefined;

			for (const actionGroup of actionGroups) {
				let hasGroupCategory = false;
				for (const action of actionGroup[1]) {
					if (action instanceof MenuItemAction) {
						if (!hasGroupCategory) {
							const category = getCategoryLabel(action);
							if (category !== lastCategoryName) {
								items.push({ type: 'separator', label: category });
								lastCategoryName = category;
							}
							hasGroupCategory = true;
						}
						const label = typeof action.item.title === 'string' ? action.item.title : action.item.title.value;
						items.push({
							type: 'item',
							id: action.item.id,
							label
						});
					}
				}
			}

			items.push({
				type: 'separator'
			});

			const entriesBeforeConfig = items.length;

			if (RemoteStatusIndicator.SHOW_CLOSE_REMOTE_COMMAND_ID) {
				if (this.remoteAuthority) {
					items.push({
						type: 'item',
						id: RemoteStatusIndicator.CLOSE_REMOTE_COMMAND_ID,
						label: nls.localize('closeRemoteConnection.title', 'Close Remote Connection')
					});

					if (this.connectionState === 'disconnected') {
						items.push({
							type: 'item',
							id: ReloadWindowAction.ID,
							label: nls.localize('reloadWindow', 'Reload Window')
						});
					}
				} else if (this.virtualWorkspaceLocation) {
					items.push({
						type: 'item',
						id: RemoteStatusIndicator.CLOSE_REMOTE_COMMAND_ID,
						label: nls.localize('closeVirtualWorkspace.title', 'Close Remote Workspace')
					});
				}
			}

			if (!this.remoteAuthority && !this.virtualWorkspaceLocation && this.extensionGalleryService.isEnabled() && this.extensionsToInstall.size > 0) {
				items.push({
					id: RemoteStatusIndicator.INSTALL_REMOTE_EXTENSIONS_ID,
					label: nls.localize('installRemotes', "Install Additional Remote Extensions..."),

					alwaysShow: true
				});
			}

			if (items.length === entriesBeforeConfig) {
				items.pop(); // remove the separator again
			}

			return items;
		};

		const quickPick = this.quickInputService.createQuickPick();
		quickPick.placeholder = nls.localize('remoteActions', "Select an option to open a Remote Window");
		quickPick.items = computeItems();
		quickPick.sortByLabel = false;
		quickPick.canSelectMany = false;
		once(quickPick.onDidAccept)((_ => {
			const selectedItems = quickPick.selectedItems;
			if (selectedItems.length === 1) {
				const commandId = selectedItems[0].id!;
				this.telemetryService.publicLog2<WorkbenchActionExecutedEvent, WorkbenchActionExecutedClassification>('workbenchActionExecuted', {
					id: commandId,
					from: 'remote indicator'
				});
				this.commandService.executeCommand(commandId);
			}

			quickPick.hide();
		}));

		// refresh the items when actions change
		const legacyItemUpdater = this.legacyIndicatorMenu.onDidChange(() => quickPick.items = computeItems());
		quickPick.onDidHide(legacyItemUpdater.dispose);

		const itemUpdater = this.remoteIndicatorMenu.onDidChange(() => quickPick.items = computeItems());
		quickPick.onDidHide(itemUpdater.dispose);

		quickPick.show();
	}

	private hasRemoteMenuCommands(ignoreInstallAdditional: boolean): boolean {
		if (this.remoteAuthority !== undefined || this.virtualWorkspaceLocation !== undefined) {
			if (RemoteStatusIndicator.SHOW_CLOSE_REMOTE_COMMAND_ID) {
				return true;
			}
		} else if (!ignoreInstallAdditional && this.extensionGalleryService.isEnabled()) {
			return true;
		}
		return this.getRemoteMenuActions().length > 0;
	}
}
