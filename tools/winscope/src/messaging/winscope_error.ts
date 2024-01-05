/*
 * Copyright (C) 2023 The Android Open Source Project
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

import {ElapsedTimestamp, TimeRange} from 'common/time';
import {TimeUtils} from 'common/time_utils';

export interface WinscopeError {
  getType(): string;
  getMessage(): string;
}

export class CorruptedArchive implements WinscopeError {
  constructor(private readonly file: File) {}

  getType(): string {
    return 'corrupted archive';
  }

  getMessage(): string {
    return `${this.file.name}: corrupted archive`;
  }
}

export class NoCommonTimestampType implements WinscopeError {
  getType(): string {
    return 'no common timestamp';
  }

  getMessage(): string {
    return 'Failed to load traces because no common timestamp type could be found';
  }
}

export class NoInputFiles implements WinscopeError {
  getType(): string {
    return 'no input';
  }

  getMessage(): string {
    return `Input has no valid trace files`;
  }
}

export class TraceHasOldData implements WinscopeError {
  constructor(private readonly descriptor: string, private readonly timeGap: TimeRange) {}

  getType(): string {
    return 'old trace';
  }

  getMessage(): string {
    const elapsedTime = new ElapsedTimestamp(
      this.timeGap.to.getValueNs() - this.timeGap.from.getValueNs()
    );
    return `${this.descriptor}: discarded because data is older than ${TimeUtils.format(
      elapsedTime,
      true
    )}`;
  }
}

export class TraceOverridden implements WinscopeError {
  constructor(private readonly descriptor: string) {}

  getType(): string {
    return 'trace overridden';
  }

  getMessage(): string {
    return `${this.descriptor}: overridden by another trace of same type`;
  }
}

export class UnsupportedFileFormat implements WinscopeError {
  constructor(private readonly descriptor: string) {}

  getType(): string {
    return 'unsupported format';
  }

  getMessage(): string {
    return `${this.descriptor}: unsupported format`;
  }
}
