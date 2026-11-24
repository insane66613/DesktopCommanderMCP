import assert from 'node:assert/strict';
import { ExcelFileHandler } from '../dist/utils/files/excel.js';
import { runIfMain } from './helpers/run-if-main.js';

export default async function runTests() {
  const handler = new ExcelFileHandler();
  let rowAccesses = 0;
  let forbidRows = true;
  const sheet = {
    name: 'Sparse',
    eachRow(cb) {
      cb({ eachCell(fn) { fn({}, 1); } }, 1);
      cb({ eachCell(fn) { fn({}, 100); } }, 1001);
    },
    getRow(r) {
      rowAccesses++;
      if (forbidRows) throw new Error('unexpected rectangular allocation');
      return { getCell(c) { return { value: r === 1001 && c === 100 ? 'far' : null }; } };
    }
  };
  const book = { worksheets: [sheet] };
  const read = (range, offset, length) => handler.worksheetToArray(book, undefined, range, offset, length);
  assert.throws(() => read(), /100000-cell limit/);
  assert.equal(rowAccesses, 0, 'reject before allocating rows');
  assert.throws(() => read('A1:CV1001'), /100000-cell limit/);
  assert.equal(rowAccesses, 0);
  forbidRows = false;
  const exact = read(undefined, 0, 1000);
  assert.equal(exact.totalRows, 1001);
  assert.equal(exact.returnedRows, 1000);
  assert.equal(exact.data[0].length, 100);
  const tail = read(undefined, -1);
  assert.equal(tail.firstRow, 1001);
  assert.equal(tail.data[0][99], 'far');
  const cell = read('CV1001:CV1001');
  assert.deepEqual(cell.data, [['far']]);
  const empty = read(undefined, 1001, 1);
  assert.equal(empty.returnedRows, 0);
  assert.deepEqual(empty.data, []);
  console.log('OK Excel budget checked before allocation; exact cap, pagination, single-cell and empty ranges verified');
}
runIfMain(import.meta.url, runTests);
