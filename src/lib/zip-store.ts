/**
 * 纯 JS 实现的「仅存储（store，无压缩）」ZIP 打包器。
 *
 * 不依赖任何第三方库（项目未装 archiver/jszip）。ZIP 的 store 模式不需要
 * deflate，只要按规范写本地文件头 + 中央目录 + 结束记录即可，浏览器/系统解压
 * 都能正常识别。文件名按 UTF-8 存储（通用位标记 0x0800）。
 */

function crc32(buf: Buffer): number {
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (~crc) >>> 0;
}

export type ZipFile = { name: string; data: Buffer };

/** 把若干文件打包成一个 store 模式的 ZIP Buffer。 */
export function buildZipStore(files: ZipFile[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf8");
    const crc = crc32(f.data);
    const size = f.data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
    local.writeUInt16LE(20, 4); // 最低版本
    local.writeUInt16LE(0x0800, 6); // 通用标志：UTF-8 文件名
    local.writeUInt16LE(0, 8); // 压缩方式：store
    local.writeUInt16LE(0, 10); // 修改时间
    local.writeUInt16LE(0, 12); // 修改日期
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18); // 压缩后大小
    local.writeUInt32LE(size, 22); // 未压缩大小
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // 扩展字段长度
    parts.push(local, nameBuf, f.data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // 中央目录头签名
    cd.writeUInt16LE(20, 4); // 版本（由谁创建）
    cd.writeUInt16LE(20, 6); // 版本（所需最低）
    cd.writeUInt16LE(0x0800, 8); // 通用标志：UTF-8
    cd.writeUInt16LE(0, 10); // 压缩方式：store
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(size, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // 扩展字段长度
    cd.writeUInt16LE(0, 32); // 注释长度
    cd.writeUInt16LE(0, 34); // 磁盘编号
    cd.writeUInt16LE(0, 36); // 内部属性
    cd.writeUInt32LE(0, 38); // 外部属性
    cd.writeUInt32LE(offset, 42); // 本地文件头偏移
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + f.data.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // 结束记录签名
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // 注释长度

  return Buffer.concat([...parts, centralBuf, end]);
}
