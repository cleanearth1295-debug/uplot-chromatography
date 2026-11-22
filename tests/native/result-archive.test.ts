import { test } from "node:test";
import assert from "node:assert/strict";
import { crc32, deflateRawSync } from "node:zlib";
import { extractUnicornPortableText, importUnicornNativeCurves, inspectUnicornContainer } from "../../src/io/index.ts";
import type { Result } from "../../src/core/types.ts";

function value<T>(result: Result<T>): T {
  if (!result.ok) assert.fail(JSON.stringify(result.errors));
  return result.value;
}
function makeZip(members: Record<string, string | Uint8Array>, deflate = false): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [path, text] of Object.entries(members)) {
    const name = Buffer.from(path, "utf8");
    const plain = typeof text === "string" ? Buffer.from(text, "utf8") : Buffer.from(text);
    const payload = deflate ? deflateRawSync(plain) : plain;
    const crc = crc32(plain);
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50);
    l.writeUInt16LE(20, 4);
    l.writeUInt16LE(0x800, 6);
    l.writeUInt16LE(deflate ? 8 : 0, 8);
    l.writeUInt32LE(crc, 14);
    l.writeUInt32LE(payload.length, 18);
    l.writeUInt32LE(plain.length, 22);
    l.writeUInt16LE(name.length, 26);

    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x800, 8);
    c.writeUInt16LE(deflate ? 8 : 0, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(payload.length, 20);
    c.writeUInt32LE(plain.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    local.push(l, name, payload);
    central.push(c, name);
    offset += l.length + name.length + payload.length;
  }
  const index = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(index.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, index, end]);
}
function singlePrimitive(values: readonly number[]): Buffer {
  const buffer = Buffer.alloc(28 + values.length * 4);
  buffer.writeInt32LE(1, 1);
  buffer.writeInt32LE(-1, 5);
  buffer.writeInt32LE(1, 9);
  buffer[17] = 15;
  buffer.writeInt32LE(1, 18);
  buffer.writeInt32LE(values.length, 22);
  buffer[26] = 11;
  values.forEach((value, index) => buffer.writeFloatLE(value, 27 + index * 4));
  buffer[buffer.length - 1] = 11;
  return buffer;
}

test("inspects a native ZIP candidate and reads tested documented XML and NRBF geometry from a constructed archive", async () => {
  const coordinates = makeZip({
    "CoordinateData.Volumes": singlePrimitive([0, 1.5, 3.5]),
    "CoordinateData.Amplitudes": singlePrimitive([0, 2, 0]),
  }, true);
  const fixture = makeZip({
    "Result.xml": "<Result><Name>Synthetic lab</Name></Result>",
    "Chrom.1.Xml": "<Chromatogram><Name>Trial</Name><Curve><CurveDataType>UV</CurveDataType>" +
      "<Name>UV &amp; Blue</Name><AmplitudeUnit>mAU</AmplitudeUnit><DistanceBetweenPoints>0.5</DistanceBetweenPoints>" +
      "<DistanceToStartPoint>1</DistanceToStartPoint><IsoChroneType>Time</IsoChroneType><IsOriginalData>true</IsOriginalData>" +
      "<ColumnVolume>5</ColumnVolume><CurvePointsFileName>Chrom.1_1_True</CurvePointsFileName></Curve></Chromatogram>",
    "Chrom.1_1_True": coordinates,
  }, true);
  const inspection = value(inspectUnicornContainer(fixture, "reference.zip"));
  assert.equal(inspection.format, "unicorn-result-zip-candidate");
  const data = value(await importUnicornNativeCurves(fixture, { runId: "sample" }));
  assert.equal(data.version, undefined);
  assert.equal(data.run.curves[0]?.label, "UV & Blue");
  assert.deepEqual([...data.run.curves[0]!.x], [1, 1.5, 2]);
  assert.deepEqual([...data.run.curves[0]!.y], [0, 2, 0]);
  assert.deepEqual([...data.run.timeVolume!.volumeMl], [0, 1.5, 3.5]);
  assert.equal(data.run.column?.volumeMl, 5);
  const byVolume = value(await importUnicornNativeCurves(fixture, { runId: "sample", axis: "volume" }));
  assert.deepEqual([...byVolume.run.curves[0]!.x], [0, 1.5, 3.5]);
});

test("plain portable archive extraction validates CRC and refuses path traversal and unsupported formats", async () => {
  const fixture = makeZip({ "curves/data.csv": "X,Y\n1,2\n" });
  assert.equal(value(inspectUnicornContainer(fixture)).format, "zip");
  assert.equal(value(await extractUnicornPortableText(fixture, "curves/data.csv")), "X,Y\n1,2\n");
  const corrupt = fixture.slice();
  corrupt[30 + "curves/data.csv".length] ^= 0xff;
  assert(!(await extractUnicornPortableText(corrupt, "curves/data.csv")).ok);
  assert(!inspectUnicornContainer(makeZip({ "../outside.csv": "test" })).ok);
  const detected = value(inspectUnicornContainer(new Uint8Array(), "example.UdoE"));
  assert.equal(detected.confidence, "extension");
  assert(!(await importUnicornNativeCurves(new Uint8Array(), { runId: "example", fileName: "example.UdoE" })).ok);
  for (const [fileName, format] of [["folder.UFol", "unicorn-folder"], ["design.MIP", "modde-project"]]) {
    const inspection = value(inspectUnicornContainer(new Uint8Array(), fileName));
    assert.equal(inspection.format, format);
    assert.equal(inspection.confidence, "extension");
    assert.deepEqual(inspection.members, []);
    assert(!(await importUnicornNativeCurves(new Uint8Array(), { runId: "example", fileName })).ok);
  }
});

test("native metadata expansion and corrupt result headers fail with explicit diagnostics", async () => {
  const archive = makeZip({
    "Result.xml": '<!DOCTYPE Result [<!ENTITY ext SYSTEM "file:///forbidden">]><Result>&ext;</Result>',
    "Chrom.1.Xml": "<Chrom/>",
  });
  const result = await importUnicornNativeCurves(archive, { runId: "sample" });
  assert(!result.ok && /DTD/.test(result.errors[0]!.message));
  const bytes = new Uint8Array([0x11, 0x47, 0x11, 0x47, 0]);
  assert.equal(value(inspectUnicornContainer(bytes)).format, "unicorn-legacy-res");
  assert(!(await importUnicornNativeCurves(bytes, { runId: "sample" })).ok);
});

test("reads time and measured volume from a constructed legacy RES layout", async () => {
  const directory = 48;
  const curveOffset = directory + 2 * 344;
  const curveHeaderLength = 240;
  const sampleLength = 8;
  const samples = [[0, 0], [10, 8], [25, 0]] as const;
  const size = curveHeaderLength + sampleLength * samples.length;
  const fixture = Buffer.alloc(curveOffset + size);
  fixture.set([0x11, 0x47, 0x11, 0x47]);
  fixture.writeUInt32LE(directory, 8);
  fixture.writeUInt32LE(fixture.length, 16);
  fixture.write("UNICORN 3.10", 24, "ascii");
  fixture.writeUInt16LE(1, directory);
  fixture.writeUInt16LE(4, directory + 2);
  fixture[directory + 4] = 1;
  fixture[directory + 5] = 0x14;
  fixture.write("=Run:1_UV", directory + 6, "ascii");
  fixture.writeUInt32LE(size, directory + 302);
  fixture.writeUInt32LE(curveOffset, directory + 310);
  fixture.writeUInt32LE(curveHeaderLength, directory + 314);
  fixture.writeUInt16LE(6, curveOffset);
  fixture.writeUInt16LE(2, curveOffset + 2);
  fixture.writeUInt16LE(1, curveOffset + 4);
  const descriptors = [[0x8001, 0.5], [0x8002, 0.1], [0x4000, 0.25]] as const;
  descriptors.forEach(([type, scale], index) => {
    const offset = curveOffset + 6 + 78 * index;
    fixture.writeUInt16LE(78, offset);
    fixture.writeUInt16LE(type, offset + 2);
    fixture.writeUInt16LE(0x0104, offset + 60);
    fixture.writeDoubleLE(scale, offset + 62);
    if (type === 0x4000) fixture.write("mAU", offset + 44, "ascii");
  });
  samples.forEach(([volume, signal], index) => {
    const offset = curveOffset + curveHeaderLength + sampleLength * index;
    fixture.writeInt32LE(volume, offset);
    fixture.writeInt32LE(signal, offset + 4);
  });
  const time = value(await importUnicornNativeCurves(fixture, { runId: "legacy", axis: "time" })).run.curves[0]!;
  assert.equal(time.label, "UV");
  assert.equal(time.signalUnit, "mAU");
  assert.deepEqual([...time.x], [0, 0.5, 1]);
  assert.deepEqual([...time.y], [0, 2, 0]);
  const volume = value(await importUnicornNativeCurves(fixture, { runId: "legacy", axis: "volume" })).run.curves[0]!;
  assert.deepEqual([...volume.x], [0, 1, 2.5]);
});
