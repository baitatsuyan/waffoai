import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickResponders, stripCall, callNames } from '../public/talk-logic.js';

const shion = { id: 1, name: 'シオン' };
const kai = { id: 2, name: 'カイ' };
const yui = { id: 3, name: 'ユイ先生' };
const members = [shion, kai, yui];
const names = (xs) => xs.map((x) => x.name);

test('名前を呼ばれたキャラが、呼ばれた順に答える', () => {
  assert.deepEqual(names(pickResponders('カイ、今日のメニューは？', members)), ['カイ']);
  assert.deepEqual(names(pickResponders('ユイ、それとシオンも聞いて', members)), ['ユイ先生', 'シオン']);
  assert.deepEqual(callNames('ユイ先生'), ['ユイ先生', 'ユイ']);
});

test('呼ばれなければ「みんな」→全員、1人なら本人、それ以外は直前に話したキャラ（最初は全員）', () => {
  assert.deepEqual(names(pickResponders('みんな、おはよう', members, 2)), ['シオン', 'カイ', 'ユイ先生']);
  assert.deepEqual(names(pickResponders('それで？', [kai])), ['カイ']);
  assert.deepEqual(names(pickResponders('それで？', members, 2)), ['カイ']);
  assert.deepEqual(names(pickResponders('こんにちは', members)), ['シオン', 'カイ', 'ユイ先生']);
});

test('呼びかけの部分を外して、用件だけをキャラに渡す', () => {
  assert.equal(stripCall('シオン、明日10時に歯医者', shion), '明日10時に歯医者');
  assert.equal(stripCall('ねえ、ユイ先生、この問題わからない', yui), 'ねえ、この問題わからない');
  assert.equal(stripCall('シオン', shion), 'シオン'); // 名前だけなら、そのまま
});
