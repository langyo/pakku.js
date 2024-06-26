import {AnyObject} from "../core/types";

const COMPRESS_THRESHOLD = 8000; // browser limit is 8192: https://developer.chrome.com/docs/extensions/reference/api/storage#property-sync-sync-QUOTA_BYTES_PER_ITEM

// below: hand-crafted base85 codec
// borrowed from https://github.com/nE0sIghT/ascii85.js/blob/master/ascii85.js

let base85 = (function () {
    const TUPLE_BITS = [0, 8, 16, 24];
    const CHARSET_BASE = 0x28;
    const POW_85_4 = [
        1,
        85,
        85 * 85,
        85 * 85 * 85,
        85 * 85 * 85 * 85,
    ];

    let _buf_4 = new Uint8Array(4);
    let _buf_5 = new Uint8Array(5);

    function getEncodedChunk(tuple: Uint8Array, bytes = 4) {
        let d = ((tuple[3] << 24) | (tuple[2] << 16) | (tuple[1] << 8) | tuple[0]) >>> 0;

        for (let i = 0; i <= 4; i++) {
            if (i <= bytes) {
                _buf_5[i] = d % 85 + CHARSET_BASE;
            } else {
                _buf_5[i] = 85 + CHARSET_BASE;
            }
            d = Math.trunc(d / 85);
        }
        return _buf_5;
    }

    function encode(byteArray: Uint8Array) {
        let output = [];

        for (let i = 0; i < byteArray.length; i += 4) {
            let bytes = 4;

            for (let j = 0; j < 4; j++) {
                if (i + j < byteArray.length) {
                    _buf_4[j] = byteArray[i + j];
                } else {
                    _buf_4[j] = 0;
                    bytes--;
                }
            }

            let chunk = getEncodedChunk(_buf_4, bytes);
            output.push(...chunk);
        }

        return String.fromCharCode.apply(null, output);
    }

    function getByteArrayPart(tuple: number, bytes = 4) {
        for (let i = 0; i < bytes; i++) {
            _buf_4[i] = (tuple >> TUPLE_BITS[i]) & 0x00ff;
        }
        return _buf_4;
    }

    function decode(text: string) {
        let output: number[] = [];

        let tuple = 0;
        let tupleIndex = 0;
        let pad = 0;

        let i = 0;
        do {
            let c_delta = text.charCodeAt(i) - CHARSET_BASE;
            if (c_delta<0 || c_delta>85) {
                throw new Error('pakku compressor: cannot decode char delta '+c_delta);
            }
            if(c_delta===85) {
                c_delta = 0;
                pad++;
            }

            tuple += c_delta * POW_85_4[tupleIndex++];

            if (tupleIndex >= 5) {
                let part = getByteArrayPart(tuple, tupleIndex - 1);
                for (let j = 0; j < tupleIndex - 1 - pad; j++) {
                    output.push(part[j]);
                }
                tuple = 0;
                tupleIndex = 0;
                pad = 0;
            }
        } while (i++ < text.length);

        return new Uint8Array(output);
    }

    return {
        encode: encode,
        decode: decode,
    };
})();

// below: deflate compression
// borrowed from https://evanhahn.com/javascript-compression-streams-api-with-strings/

async function concat_u8_array(arrays: Uint8Array[]): Promise<Uint8Array> {
    let ab = await new Blob(arrays).arrayBuffer();
    return new Uint8Array(ab);
}

async function flow_through(stream: TransformStream, input: Uint8Array): Promise<Uint8Array> {
    // cannot use for-await until chrome 124!
    // https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream

    let writer = stream.writable.getWriter();
    void writer.write(input);
    void writer.close();

    let chunks = [];
    let reader = stream.readable.getReader();
    while(true) {
        let {done, value} = await reader.read();
        if(done)
            break;
        chunks.push(value);
    }

    return await concat_u8_array(chunks);
}

async function compress_str(s: Uint8Array): Promise<string> {
    return base85.encode(
        await flow_through(
            new CompressionStream('deflate'),
            s,
        )
    );
}

async function decompress_str(s: string): Promise<string> {
    return new TextDecoder().decode(
        await flow_through(
            new DecompressionStream('deflate'),
            base85.decode(s),
        )
    );
}

// below: compressed object signature

async function compress(o: any): Promise<any> {
    // small data do not need compression
    if(o===null || typeof o === 'boolean' || typeof o === 'number' || (typeof o === 'string' && o.length<=COMPRESS_THRESHOLD/4))
        return o;

    let encoded = new TextEncoder().encode(JSON.stringify(o));
    if(encoded.length<=COMPRESS_THRESHOLD)
        return o;

    let compressed = await compress_str(encoded);

    console.log(`pakku compressor: length ${encoded.length} -> ${compressed.length}`);
    return {'_cpv': '1', '_d': compressed};
}

async function decompress(o: any): Promise<any> {
    let is_compressed = o!==null && typeof o === 'object' && o['_cpv'];
    if(!is_compressed)
        return o;

    if(o['_cpv']!=='1')
        throw new Error('pakku compressor: cannot decompress unknown version '+o['_cpv']);

    let decompressed = await decompress_str(o['_d']);
    return JSON.parse(decompressed);
}

export async function compress_all(obj: AnyObject): Promise<AnyObject> {
    let ret: AnyObject = {};
    for(let k in obj) {
        ret[k] = await compress(obj[k]);
    }
    return ret;
}

export async function decompress_all(obj: AnyObject): Promise<AnyObject> {
    let ret: AnyObject = {};
    for(let k in obj) {
        ret[k] = await decompress(obj[k]);
    }
    return ret;
}