import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLessons, locateOnFrame, rememberLesson, unzoom2x, type Locator } from '@cassie/runtime';

const miss: Locator = { name: 'miss', ask: async () => ({ box: [0, 0, 0, 0], score: 0, present: false }) };

describe('locate harness (before SAM)', () => {
  it('maps a box found in a 2× centre crop back to the original frame', () => {
    expect(unzoom2x([10, 8, 20, 16], 400, 200)).toEqual([110, 58, 20, 16]);
  });

  it('probes zoom after a full-frame miss and remembers that lesson', async () => {
    const seen: string[] = [];
    const locator: Locator = {
      name: 'fake',
      async ask(_image, prompt) {
        seen.push(prompt);
        if (prompt.includes('visible part')) return { box: [4, 4, 20, 20], score: 0.81, present: true };
        return { box: [0, 0, 0, 0], score: 0, present: false };
      },
    };
    const dir = await mkdtemp(join(tmpdir(), 'cassie-locate-'));
    const frame = join(dir, 'f.png');
    // 8×8 PNG is enough: locateOnFrame only reads the image for zoom via ffmpeg; skip zoom by not using it.
    await writeFile(frame, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
    const hit = await locateOnFrame(locator, frame, 'phone', dir, ['visible_part'], 0.3);
    expect(hit?.lesson).toBe('visible_part');
    expect(hit?.score).toBe(0.81);
    expect(seen[0]).toMatch(/visible part/);
    const project = join(dir, 'project.cassie.json');
    await rememberLesson(project, 'phone', 'phone', hit!.lesson);
    expect(await loadLessons(project, 'phone')).toEqual(['visible_part']);
    const again = await locateOnFrame(locator, frame, 'phone', dir, await loadLessons(project, 'phone'), 0.3);
    expect(again?.lesson).toBe('visible_part');
    await rm(dir, { recursive: true, force: true });
  });

  it('does not guess when every view misses', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cassie-locate-'));
    const frame = join(dir, 'f.png');
    await writeFile(frame, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
    expect(await locateOnFrame(miss, frame, 'phone', dir, ['full'], 0.3)).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });
});
