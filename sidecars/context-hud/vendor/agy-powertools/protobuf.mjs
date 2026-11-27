// Wire reader for the local Antigravity protobuf schema. Unknown fields are skipped.
export function fields(bytes) {
  const data = Buffer.from(bytes || []);
  const result = new Map();
  let offset = 0;
  const varint = () => {
    let value = 0n;
    for (let shift = 0n; shift < 70n && offset < data.length; shift += 7n) {
      const byte = data[offset++];
      value |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) return value;
    }
    throw new Error('Invalid protobuf varint');
  };
  while (offset < data.length) {
    const key = Number(varint());
    const number = key >>> 3;
    const wire = key & 7;
    if (!number) throw new Error('Invalid protobuf field');
    let value;
    if (wire === 0) value = Number(BigInt.asIntN(64, varint()));
    else if ([1, 2, 5].includes(wire)) {
      const length = wire === 2 ? Number(varint()) : wire === 1 ? 8 : 4;
      if (length < 0 || offset + length > data.length) throw new Error('Truncated protobuf');
      value = data.subarray(offset, offset + length);
      offset += length;
    } else throw new Error('Unsupported protobuf wire type');
    if (!result.has(number)) result.set(number, []);
    result.get(number).push(value);
  }
  return result;
}

export const first = (map, number, fallback = null) => map.get(number)?.[0] ?? fallback;
export const nested = (map, number) => fields(first(map, number));
export const string = (map, number) => Buffer.from(first(map, number, [])).toString('utf8');
export function milliseconds(bytes) {
  if (!bytes) return null;
  const map = fields(bytes);
  return first(map, 1, 0) * 1000 + first(map, 2, 0) / 1e6;
}
