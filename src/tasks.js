/**
 * Copyright (c) 2017-present PlatformIO <contact@platformio.org>
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

import * as pioNodeHelpers from 'platformio-node-helpers';
import * as utils from './utils';

import { IS_WINDOWS } from './constants';
import path from 'path';
import vscode from 'vscode';


export default class TaskManager {

  static AUTO_REFRESH_DELAY = 500; // 0.5 sec
  static type = 'PlatformIO';

  constructor() {
    this.subscriptions = [];
    this.internalSubscriptions = [];
    this.onDidTasksUpdatedCallbacks = [];

    this._projectDir = undefined;
    this._refreshTimeout = undefined;
    this._tasks = undefined;

    this.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(
      () => this.checkActiveProjectDir())
    );
    this.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(
      () => this.checkActiveProjectDir())
    );
  }

  async getTasks() {
    if (this._tasks) {
      return this._tasks;
    }
    const pt = new pioNodeHelpers.project.ProjectTasks(this._projectDir, 'vscode');
    this._tasks = await pt.getTasks();
    return this._tasks;
  }

  toVSCodeTask(projectTask) {
    const vscodeTask = new vscode.Task(
      {
        type: TaskManager.type,
        task: projectTask.id
      },
      vscode.workspace.getWorkspaceFolder(vscode.Uri.file(this._projectDir)),
      projectTask.title,
      TaskManager.type,
      new vscode.ProcessExecution(IS_WINDOWS ? 'platformio.exe' : 'platformio', projectTask.args, {
        cwd: this._projectDir,
        env: process.env
      }),
      '$platformio'
    );
    vscodeTask.presentationOptions = {
      panel: vscode.TaskPanelKind.Dedicated
    };
    if (projectTask.isBuild()) {
      vscodeTask.group = vscode.TaskGroup.Build;
    } else if (projectTask.isClean()) {
      vscodeTask.group = vscode.TaskGroup.Clean;
    } else if (projectTask.isTest()) {
      vscodeTask.group = vscode.TaskGroup.Test;
    }
    return vscodeTask;
  }

  registerProvider() {
    this.checkActiveProjectDir();
  }

  checkActiveProjectDir() {
    const projectDir = utils.getActivePIOProjectDir();
    if (!projectDir) {
      this._projectDir = undefined;
      this.refresh();
      return;
    }
    if (this._projectDir === projectDir) {
      return;
    }
    this._projectDir = projectDir;
    this.requestRefresh();
  }

  onDidTasksUpdated(callback) {
    this.onDidTasksUpdatedCallbacks.push(callback);
    return new vscode.Disposable(() => pioNodeHelpers.misc.arrayRemove(this.onDidTasksUpdatedCallbacks, callback));
  }

  disposeInternal() {
    pioNodeHelpers.misc.disposeSubscriptions(this.internalSubscriptions);
    this._tasks = undefined;
  }

  dispose() {
    this.disposeInternal();
    pioNodeHelpers.misc.disposeSubscriptions(this.subscriptions);
  }

  requestRefresh() {
    if (this._refreshTimeout) {
      clearTimeout(this._refreshTimeout);
    }
    this._refreshTimeout = setTimeout(this.refresh.bind(this), TaskManager.AUTO_REFRESH_DELAY);
  }

  async refresh() {
    this.disposeInternal();
    if (this._projectDir) {
      const provider = vscode.tasks.registerTaskProvider(TaskManager.type, {
        provideTasks: async () => {
          return (await this.getTasks()).map(task => this.toVSCodeTask(task));
        },
        resolveTask: () => {
          return undefined;
        }
      });
      this.internalSubscriptions.push(provider);
      this.addProjectConfigWatcher(this._projectDir);
      this.controlDeviceMonitorTasks();
    }
    const tasks = await this.getTasks();
    this.onDidTasksUpdatedCallbacks.forEach(cb => cb(tasks));
  }

  addProjectConfigWatcher(projectDir) {
    try {
      const watcher = vscode.workspace.createFileSystemWatcher(
        path.join(projectDir, 'platformio.ini')
      );
      this.internalSubscriptions.push(watcher);

      this.internalSubscriptions.push(watcher.onDidCreate(() => {
        this.requestRefresh();
      }));
      this.internalSubscriptions.push(watcher.onDidChange(() => {
        this.requestRefresh();
      }));
      this.internalSubscriptions.push(watcher.onDidDelete(() => {
        this.dispose();
      }));

    } catch (err) {
      utils.notifyError('Tasks FileSystemWatcher', err);
    }
  }

  controlDeviceMonitorTasks() {
    let restoreAfterTask = undefined;
    let restoreTasks = [];

    this.internalSubscriptions.push(vscode.tasks.onDidStartTaskProcess((event) => {
      if (!vscode.workspace.getConfiguration('platformio-ide').get('autoCloseSerialMonitor')) {
        return;
      }
      if (!['upload', 'test'].some(arg => event.execution.task.execution.args.includes(arg))) {
        return;
      }
      vscode.tasks.taskExecutions.forEach((e) => {
        if (event.execution.task === e.task) {
          return;
        }
        if (['device', 'monitor'].every(arg => e.task.execution.args.includes(arg))) {
          restoreTasks.push(e.task);
        }
        if (e.task.execution.args.includes('monitor')) {
          e.terminate();
        }
      });
      restoreAfterTask = event.execution.task;
    }));

    this.internalSubscriptions.push(vscode.tasks.onDidEndTaskProcess((event) => {
      if (event.execution.task !== restoreAfterTask) {
        return;
      }
      restoreTasks.forEach(task => {
        vscode.tasks.executeTask(task);
      });
      restoreTasks = [];
    }));
  }
}
