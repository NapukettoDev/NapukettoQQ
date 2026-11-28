export function wavHeader(bytes: number, sampleRate: number): Buffer {
    const header = Buffer.alloc(44);
    header.write("RIFF", 0, "ascii");
    header.writeUInt32LE(36 + bytes, 4);
    header.write("WAVEfmt ", 8, "ascii");
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36, "ascii");
    header.writeUInt32LE(bytes, 40);
    return header;
}

export interface WavPcm {
    offset: number;
    bytes: number;
    sampleRate: number;
}

export function isRiffWave(header: Buffer): boolean {
    return (
        header.toString("latin1", 0, 4) === "RIFF" && header.toString("latin1", 8, 12) === "WAVE"
    );
}

function readMonoWavRate(header: Buffer, offset: number, bytes: number): number | undefined {
    if (
        bytes < 16 ||
        offset + 16 > header.length ||
        header.readUInt16LE(offset) !== 1 ||
        header.readUInt16LE(offset + 2) !== 1 ||
        header.readUInt16LE(offset + 12) !== 2 ||
        header.readUInt16LE(offset + 14) !== 16
    ) {
        return undefined;
    }
    return header.readUInt32LE(offset + 4);
}

/** Locate common PCM WAV chunks without walking the audio payload. Other WAVs use ffmpeg. */
export function monoWavPcm(header: Buffer, fileSize: number): WavPcm | undefined {
    if (!isRiffWave(header) || header.readUInt32LE(4) + 8 !== fileSize) return undefined;
    let sampleRate: number | undefined;
    for (let offset = 12; offset + 8 <= header.length; ) {
        const name = header.toString("latin1", offset, offset + 4);
        const bytes = header.readUInt32LE(offset + 4);
        const data = offset + 8;
        if (data + bytes > fileSize) return undefined;
        if (name === "fmt ") {
            sampleRate = readMonoWavRate(header, data, bytes);
            if (sampleRate === undefined) return undefined;
        }
        if (name === "data" && sampleRate !== undefined && bytes % 2 === 0) {
            return { offset: data, bytes, sampleRate };
        }
        offset = data + bytes + (bytes % 2);
    }
    return undefined;
}
