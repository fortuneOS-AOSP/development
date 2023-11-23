/*
 * Copyright (C) 2022 The Android Open Source Project
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {Timestamp} from 'common/time';
import {ProgressListener} from 'messaging/progress_listener';
import {UserNotificationListener} from 'messaging/user_notification_listener';
import {
  TracePositionUpdate,
  ViewersLoaded,
  ViewersUnloaded,
  WinscopeEvent,
  WinscopeEventType,
} from 'messaging/winscope_event';
import {WinscopeEventEmitter} from 'messaging/winscope_event_emitter';
import {WinscopeEventListener} from 'messaging/winscope_event_listener';
import {TraceEntry} from 'trace/trace';
import {TracePosition} from 'trace/trace_position';
import {Viewer} from 'viewers/viewer';
import {ViewerFactory} from 'viewers/viewer_factory';
import {FilesSource} from './files_source';
import {TimelineData} from './timeline_data';
import {TracePipeline} from './trace_pipeline';

export class Mediator {
  private abtChromeExtensionProtocol: WinscopeEventEmitter & WinscopeEventListener;
  private crossToolProtocol: WinscopeEventEmitter & WinscopeEventListener;
  private uploadTracesComponent?: ProgressListener;
  private collectTracesComponent?: ProgressListener;
  private traceViewComponent?: WinscopeEventEmitter & WinscopeEventListener;
  private timelineComponent?: WinscopeEventEmitter & WinscopeEventListener;
  private appComponent: WinscopeEventListener;
  private userNotificationListener: UserNotificationListener;
  private storage: Storage;

  private tracePipeline: TracePipeline;
  private timelineData: TimelineData;
  private viewers: Viewer[] = [];
  private areViewersLoaded = false;
  private lastRemoteToolTimestampReceived: Timestamp | undefined;
  private currentProgressListener?: ProgressListener;

  constructor(
    tracePipeline: TracePipeline,
    timelineData: TimelineData,
    abtChromeExtensionProtocol: WinscopeEventEmitter & WinscopeEventListener,
    crossToolProtocol: WinscopeEventEmitter & WinscopeEventListener,
    appComponent: WinscopeEventListener,
    userNotificationListener: UserNotificationListener,
    storage: Storage
  ) {
    this.tracePipeline = tracePipeline;
    this.timelineData = timelineData;
    this.abtChromeExtensionProtocol = abtChromeExtensionProtocol;
    this.crossToolProtocol = crossToolProtocol;
    this.appComponent = appComponent;
    this.userNotificationListener = userNotificationListener;
    this.storage = storage;

    this.crossToolProtocol.setEmitEvent(async (event) => {
      await this.onWinscopeEvent(event);
    });

    this.abtChromeExtensionProtocol.setEmitEvent(async (event) => {
      await this.onWinscopeEvent(event);
    });
  }

  setUploadTracesComponent(component: ProgressListener | undefined) {
    this.uploadTracesComponent = component;
  }

  setCollectTracesComponent(component: ProgressListener | undefined) {
    this.collectTracesComponent = component;
  }

  setTraceViewComponent(component: (WinscopeEventEmitter & WinscopeEventListener) | undefined) {
    this.traceViewComponent = component;
    this.traceViewComponent?.setEmitEvent(async (event) => {
      await this.onWinscopeEvent(event);
    });
  }

  setTimelineComponent(component: (WinscopeEventEmitter & WinscopeEventListener) | undefined) {
    this.timelineComponent = component;
    this.timelineComponent?.setEmitEvent(async (event) => {
      await this.onWinscopeEvent(event);
    });
  }

  async onWinscopeEvent(event: WinscopeEvent) {
    await event.visit(WinscopeEventType.APP_INITIALIZED, async (event) => {
      await this.abtChromeExtensionProtocol.onWinscopeEvent(event);
    });

    await event.visit(WinscopeEventType.APP_FILES_UPLOADED, async (event) => {
      this.currentProgressListener = this.uploadTracesComponent;
      await this.tracePipeline.loadFiles(
        event.files,
        this.currentProgressListener,
        FilesSource.UPLOADED
      );
    });

    await event.visit(WinscopeEventType.APP_FILES_COLLECTED, async (event) => {
      this.currentProgressListener = this.collectTracesComponent;
      await this.tracePipeline.loadFiles(
        event.files,
        this.currentProgressListener,
        FilesSource.COLLECTED
      );
      await this.processLoadedTraceFiles();
    });

    await event.visit(WinscopeEventType.APP_RESET_REQUEST, async () => {
      await this.resetAppToInitialState();
    });

    await event.visit(WinscopeEventType.APP_TRACE_VIEW_REQUEST, async () => {
      await this.processLoadedTraceFiles();
    });

    await event.visit(WinscopeEventType.BUGANIZER_ATTACHMENTS_DOWNLOAD_START, async () => {
      await this.resetAppToInitialState();
      this.currentProgressListener = this.uploadTracesComponent;
      this.currentProgressListener?.onProgressUpdate('Downloading files...', undefined);
    });

    await event.visit(WinscopeEventType.BUGANIZER_ATTACHMENTS_DOWNLOADED, async (event) => {
      this.currentProgressListener = this.uploadTracesComponent;
      await this.processRemoteFilesReceived(event.files, FilesSource.BUGANIZER);
    });

    await event.visit(WinscopeEventType.TABBED_VIEW_SWITCH_REQUEST, async (event) => {
      await this.traceViewComponent?.onWinscopeEvent(event);
    });

    await event.visit(WinscopeEventType.TABBED_VIEW_SWITCHED, async (event) => {
      await this.appComponent.onWinscopeEvent(event);
      this.timelineData.setActiveViewTraceTypes(event.newFocusedView.dependencies);
      await this.propagateTracePosition(this.timelineData.getCurrentPosition(), false);
    });

    await event.visit(WinscopeEventType.TRACE_POSITION_UPDATE, async (event) => {
      await this.propagateTracePosition(event.position, false);
    });

    await event.visit(WinscopeEventType.REMOTE_TOOL_BUGREPORT_RECEIVED, async (event) => {
      this.currentProgressListener = this.uploadTracesComponent;
      await this.processRemoteFilesReceived([event.bugreport], FilesSource.BUGREPORT);
      if (event.timestamp !== undefined) {
        await this.onRemoteToolTimestampReceived(event.timestamp);
      }
    });

    await event.visit(WinscopeEventType.REMOTE_TOOL_TIMESTAMP_RECEIVED, async (event) => {
      await this.onRemoteToolTimestampReceived(event.timestamp);
    });
  }

  private async propagateTracePosition(
    position: TracePosition | undefined,
    omitCrossToolProtocol: boolean
  ) {
    if (!position) {
      return;
    }

    //TODO (b/289478304): update only visible viewers (1 tab viewer + overlay viewers)
    const event = new TracePositionUpdate(position);
    const receivers: WinscopeEventListener[] = [...this.viewers];
    if (!omitCrossToolProtocol) {
      receivers.push(this.crossToolProtocol);
    }
    if (this.timelineComponent) {
      receivers.push(this.timelineComponent);
    }

    const promises = receivers.map((receiver) => {
      return receiver.onWinscopeEvent(event);
    });
    await Promise.all(promises);
  }

  private async onRemoteToolTimestampReceived(timestamp: Timestamp) {
    this.lastRemoteToolTimestampReceived = timestamp;

    if (!this.areViewersLoaded) {
      return; // apply timestamp later when traces are visualized
    }

    if (this.timelineData.getTimestampType() !== timestamp.getType()) {
      console.warn(
        'Cannot apply new timestamp received from remote tool.' +
          ` Remote tool notified timestamp type ${timestamp.getType()},` +
          ` but Winscope is accepting timestamp type ${this.timelineData.getTimestampType()}.`
      );
      return;
    }

    const position = this.timelineData.makePositionFromActiveTrace(timestamp);
    this.timelineData.setPosition(position);

    await this.propagateTracePosition(this.timelineData.getCurrentPosition(), true);
  }

  private async processRemoteFilesReceived(files: File[], defaultFileName = FilesSource.REMOTE) {
    await this.resetAppToInitialState();
    await this.tracePipeline.loadFiles(files, this.currentProgressListener, defaultFileName);
  }

  private async processLoadedTraceFiles() {
    this.currentProgressListener?.onProgressUpdate('Computing frame mapping...', undefined);

    // TODO: move this into the ProgressListener
    // allow the UI to update before making the main thread very busy
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    await this.tracePipeline.buildTraces();
    this.currentProgressListener?.onOperationFinished();

    this.currentProgressListener?.onProgressUpdate('Initializing UI...', undefined);

    // TODO: move this into the ProgressListener
    // allow the UI to update before making the main thread very busy
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    this.timelineData.initialize(
      this.tracePipeline.getTraces(),
      await this.tracePipeline.getScreenRecordingVideo()
    );

    this.viewers = new ViewerFactory().createViewers(this.tracePipeline.getTraces(), this.storage);
    this.viewers.forEach((viewer) =>
      viewer.setEmitEvent(async (event) => {
        await this.onWinscopeEvent(event);
      })
    );

    await this.appComponent.onWinscopeEvent(new ViewersLoaded(this.viewers));

    // Set initial trace position as soon as UI is created
    const initialPosition = this.getInitialTracePosition();
    this.timelineData.setPosition(initialPosition);
    await this.propagateTracePosition(initialPosition, true);

    this.areViewersLoaded = true;
  }

  private getInitialTracePosition(): TracePosition | undefined {
    if (
      this.lastRemoteToolTimestampReceived &&
      this.timelineData.getTimestampType() === this.lastRemoteToolTimestampReceived.getType()
    ) {
      return this.timelineData.makePositionFromActiveTrace(this.lastRemoteToolTimestampReceived);
    }

    const position = this.timelineData.getCurrentPosition();
    if (position) {
      return position;
    }

    // TimelineData might not provide a TracePosition because all the loaded traces are
    // dumps with invalid timestamps (value zero). In this case let's create a TracePosition
    // out of any entry from the loaded traces (if available).
    const firstEntries = this.tracePipeline
      .getTraces()
      .mapTrace((trace) => {
        if (trace.lengthEntries > 0) {
          return trace.getEntry(0);
        }
        return undefined;
      })
      .filter((entry) => {
        return entry !== undefined;
      }) as Array<TraceEntry<object>>;

    if (firstEntries.length > 0) {
      return TracePosition.fromTraceEntry(firstEntries[0]);
    }

    return undefined;
  }

  private async resetAppToInitialState() {
    this.tracePipeline.clear();
    this.timelineData.clear();
    this.viewers = [];
    this.areViewersLoaded = false;
    this.lastRemoteToolTimestampReceived = undefined;
    await this.appComponent.onWinscopeEvent(new ViewersUnloaded());
  }
}
