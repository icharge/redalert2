interface LzoState {
    inputBuffer: Uint8Array;
    outputBuffer: Uint8Array | null;
}

interface LzoConfig {
    outputSize?: number;
    blockSize?: number;
}

class Lzo1xImpl {
    blockSize = 128 * 1024;
    minNewSize = this.blockSize;
    maxSize = 0;
    OK = 0;
    INPUT_OVERRUN = -4;
    OUTPUT_OVERRUN = -5;
    LOOKBEHIND_OVERRUN = -6;
    EOF_FOUND = -999;
    ret = 0;
    buf: Uint8Array | null = null;
    buf32: Uint32Array | null = null;
    out = new Uint8Array(256 * 1024);
    cbl = 0;
    ip_end = 0;
    op_end = 0;
    t = 0;
    ip = 0;
    op = 0;
    m_pos = 0;
    m_len = 0;
    m_off = 0;
    dv_hi = 0;
    dv_lo = 0;
    dindex = 0;
    ii = 0;
    jj = 0;
    tt = 0;
    v = 0;
    ip_start = 0;
    ti = 0;
    prev_ip = 0;
    ll = 0;
    l = 0;
    dict = new Uint32Array(16384);
    emptyDict = new Uint32Array(16384);
    skipToFirstLiteralFun = false;
    returnNewBuffers = true;
    state: LzoState = { inputBuffer: new Uint8Array(), outputBuffer: null };

    setBlockSize(blockSize: number) {
        if (typeof blockSize === 'number' && !isNaN(blockSize) && parseInt(String(blockSize), 10) > 0) {
            this.blockSize = parseInt(String(blockSize), 10);
            return true;
        }
        return false;
    }

    setOutputSize(outputSize: number) {
        if (typeof outputSize === 'number' && !isNaN(outputSize) && parseInt(String(outputSize), 10) > 0) {
            this.out = new Uint8Array(parseInt(String(outputSize), 10));
            return true;
        }
        return false;
    }

    setReturnNewBuffers(value: boolean) {
        this.returnNewBuffers = !!value;
    }

    applyConfig(cfg?: LzoConfig) {
        if (cfg?.outputSize !== undefined) {
            this.setOutputSize(cfg.outputSize);
        }
        if (cfg?.blockSize !== undefined) {
            this.setBlockSize(cfg.blockSize);
        }
    }

    extendBuffer() {
        const newBuffer = new Uint8Array(this.minNewSize + (this.blockSize - this.minNewSize % this.blockSize));
        newBuffer.set(this.out);
        this.out = newBuffer;
        this.cbl = this.out.length;
    }

    match_next() {
        this.minNewSize = this.op + 3;
        if (this.minNewSize > this.cbl) {
            this.extendBuffer();
        }
        this.out[this.op++] = this.buf![this.ip++];
        if (this.t > 1) {
            this.out[this.op++] = this.buf![this.ip++];
            if (this.t > 2) {
                this.out[this.op++] = this.buf![this.ip++];
            }
        }
        this.t = this.buf![this.ip++];
    }

    match_done() {
        this.t = this.buf![this.ip - 2] & 3;
        return this.t;
    }

    copy_match() {
        this.t += 2;
        this.minNewSize = this.op + this.t;
        if (this.minNewSize > this.cbl) {
            this.extendBuffer();
        }
        do {
            this.out[this.op++] = this.out[this.m_pos++];
        } while (--this.t > 0);
    }

    copy_from_buf() {
        this.minNewSize = this.op + this.t;
        if (this.minNewSize > this.cbl) {
            this.extendBuffer();
        }
        do {
            this.out[this.op++] = this.buf![this.ip++];
        } while (--this.t > 0);
    }

    match() {
        for (;;) {
            if (this.t >= 64) {
                this.m_pos = (this.op - 1) - ((this.t >> 2) & 7) - (this.buf![this.ip++] << 3);
                this.t = (this.t >> 5) - 1;
                this.copy_match();
            }
            else if (this.t >= 32) {
                this.t &= 31;
                if (this.t === 0) {
                    while (this.buf![this.ip] === 0) {
                        this.t += 255;
                        this.ip++;
                    }
                    this.t += 31 + this.buf![this.ip++];
                }
                this.m_pos = (this.op - 1) - (this.buf![this.ip] >> 2) - (this.buf![this.ip + 1] << 6);
                this.ip += 2;
                this.copy_match();
            }
            else if (this.t >= 16) {
                this.m_pos = this.op - ((this.t & 8) << 11);
                this.t &= 7;
                if (this.t === 0) {
                    while (this.buf![this.ip] === 0) {
                        this.t += 255;
                        this.ip++;
                    }
                    this.t += 7 + this.buf![this.ip++];
                }
                this.m_pos -= (this.buf![this.ip] >> 2) + (this.buf![this.ip + 1] << 6);
                this.ip += 2;
                if (this.m_pos === this.op) {
                    this.state.outputBuffer = this.returnNewBuffers
                        ? new Uint8Array(this.out.subarray(0, this.op))
                        : this.out.subarray(0, this.op);
                    return this.EOF_FOUND;
                }
                this.m_pos -= 0x4000;
                this.copy_match();
            }
            else {
                this.m_pos = (this.op - 1) - (this.t >> 2) - (this.buf![this.ip++] << 2);
                this.minNewSize = this.op + 2;
                if (this.minNewSize > this.cbl) {
                    this.extendBuffer();
                }
                this.out[this.op++] = this.out[this.m_pos++];
                this.out[this.op++] = this.out[this.m_pos];
            }
            if (this.match_done() === 0) {
                return this.OK;
            }
            this.match_next();
        }
    }

    decompress(state: LzoState) {
        this.state = state;
        this.buf = this.state.inputBuffer;
        this.cbl = this.out.length;
        this.ip_end = this.buf.length;
        this.t = 0;
        this.ip = 0;
        this.op = 0;
        this.m_pos = 0;
        this.skipToFirstLiteralFun = false;
        if (this.buf[this.ip] > 17) {
            this.t = this.buf[this.ip++] - 17;
            if (this.t < 4) {
                this.match_next();
                this.ret = this.match();
                if (this.ret !== this.OK) {
                    return this.ret === this.EOF_FOUND ? this.OK : this.ret;
                }
            }
            else {
                this.copy_from_buf();
                this.skipToFirstLiteralFun = true;
            }
        }
        for (;;) {
            if (!this.skipToFirstLiteralFun) {
                this.t = this.buf[this.ip++];
                if (this.t >= 16) {
                    this.ret = this.match();
                    if (this.ret !== this.OK) {
                        return this.ret === this.EOF_FOUND ? this.OK : this.ret;
                    }
                    continue;
                }
                else if (this.t === 0) {
                    while (this.buf[this.ip] === 0) {
                        this.t += 255;
                        this.ip++;
                    }
                    this.t += 15 + this.buf[this.ip++];
                }
                this.t += 3;
                this.copy_from_buf();
            }
            else {
                this.skipToFirstLiteralFun = false;
            }
            this.t = this.buf[this.ip++];
            if (this.t < 16) {
                this.m_pos = this.op - (1 + 0x0800);
                this.m_pos -= this.t >> 2;
                this.m_pos -= this.buf[this.ip++] << 2;
                this.minNewSize = this.op + 3;
                if (this.minNewSize > this.cbl) {
                    this.extendBuffer();
                }
                this.out[this.op++] = this.out[this.m_pos++];
                this.out[this.op++] = this.out[this.m_pos++];
                this.out[this.op++] = this.out[this.m_pos];
                if (this.match_done() === 0) {
                    continue;
                }
                this.match_next();
            }
            this.ret = this.match();
            if (this.ret !== this.OK) {
                return this.ret === this.EOF_FOUND ? this.OK : this.ret;
            }
        }
    }

    // Ported from minilzo-js (https://github.com/abraidwood/minilzo-js,
    // GPL-2.0-or-later), itself a JS port of Markus F.X.J. Oberhumer's
    // minilzo.c (LZO1X-1). Produces a standard LZO1X bitstream - it doesn't
    // need to match any particular reference compressor byte-for-byte, only
    // to be decodable by this file's own decompress() (and any other
    // standard LZO1X decoder, including the real game's).
    private compressCore(): void {
        this.ip_start = this.ip;
        this.ip_end = this.ip + this.ll - 20;
        this.jj = this.ip;
        this.ti = this.t;
        this.ip += this.ti < 4 ? 4 - this.ti : 0;
        this.ip += 1 + ((this.ip - this.jj) >> 5);
        for (;;) {
            if (this.ip >= this.ip_end) {
                break;
            }
            this.dv_lo = this.buf![this.ip] | (this.buf![this.ip + 1] << 8);
            this.dv_hi = this.buf![this.ip + 2] | (this.buf![this.ip + 3] << 8);
            this.dindex = (((((this.dv_lo * 0x429d) >>> 16) + (this.dv_hi * 0x429d) + (this.dv_lo * 0x1824)) & 0xFFFF) >>> 2);
            this.m_pos = this.ip_start + this.dict[this.dindex];
            this.dict[this.dindex] = this.ip - this.ip_start;
            if ((this.dv_hi << 16) + this.dv_lo !==
                (this.buf![this.m_pos] | (this.buf![this.m_pos + 1] << 8) | (this.buf![this.m_pos + 2] << 16) | (this.buf![this.m_pos + 3] << 24))) {
                this.ip += 1 + ((this.ip - this.jj) >> 5);
                continue;
            }
            this.jj -= this.ti;
            this.ti = 0;
            this.v = this.ip - this.jj;
            if (this.v !== 0) {
                if (this.v <= 3) {
                    this.out[this.op - 2] |= this.v;
                    do {
                        this.out[this.op++] = this.buf![this.jj++];
                    } while (--this.v > 0);
                }
                else {
                    if (this.v <= 18) {
                        this.out[this.op++] = this.v - 3;
                    }
                    else {
                        this.tt = this.v - 18;
                        this.out[this.op++] = 0;
                        while (this.tt > 255) {
                            this.tt -= 255;
                            this.out[this.op++] = 0;
                        }
                        this.out[this.op++] = this.tt;
                    }
                    do {
                        this.out[this.op++] = this.buf![this.jj++];
                    } while (--this.v > 0);
                }
            }
            this.m_len = 4;
            if (this.buf![this.ip + this.m_len] === this.buf![this.m_pos + this.m_len]) {
                do {
                    this.m_len += 1;
                    if (this.buf![this.ip + this.m_len] !== this.buf![this.m_pos + this.m_len]) {
                        break;
                    }
                    this.m_len += 1;
                    if (this.buf![this.ip + this.m_len] !== this.buf![this.m_pos + this.m_len]) {
                        break;
                    }
                    this.m_len += 1;
                    if (this.buf![this.ip + this.m_len] !== this.buf![this.m_pos + this.m_len]) {
                        break;
                    }
                    this.m_len += 1;
                    if (this.buf![this.ip + this.m_len] !== this.buf![this.m_pos + this.m_len]) {
                        break;
                    }
                    this.m_len += 1;
                    if (this.buf![this.ip + this.m_len] !== this.buf![this.m_pos + this.m_len]) {
                        break;
                    }
                    this.m_len += 1;
                    if (this.buf![this.ip + this.m_len] !== this.buf![this.m_pos + this.m_len]) {
                        break;
                    }
                    this.m_len += 1;
                    if (this.buf![this.ip + this.m_len] !== this.buf![this.m_pos + this.m_len]) {
                        break;
                    }
                    this.m_len += 1;
                    if (this.buf![this.ip + this.m_len] !== this.buf![this.m_pos + this.m_len]) {
                        break;
                    }
                    if (this.ip + this.m_len >= this.ip_end) {
                        break;
                    }
                } while (this.buf![this.ip + this.m_len] === this.buf![this.m_pos + this.m_len]);
            }
            this.m_off = this.ip - this.m_pos;
            this.ip += this.m_len;
            this.jj = this.ip;
            if (this.m_len <= 8 && this.m_off <= 0x0800) {
                this.m_off -= 1;
                this.out[this.op++] = ((this.m_len - 1) << 5) | ((this.m_off & 7) << 2);
                this.out[this.op++] = this.m_off >> 3;
            }
            else if (this.m_off <= 0x4000) {
                this.m_off -= 1;
                if (this.m_len <= 33) {
                    this.out[this.op++] = 32 | (this.m_len - 2);
                }
                else {
                    this.m_len -= 33;
                    this.out[this.op++] = 32;
                    while (this.m_len > 255) {
                        this.m_len -= 255;
                        this.out[this.op++] = 0;
                    }
                    this.out[this.op++] = this.m_len;
                }
                this.out[this.op++] = this.m_off << 2;
                this.out[this.op++] = this.m_off >> 6;
            }
            else {
                this.m_off -= 0x4000;
                if (this.m_len <= 9) {
                    this.out[this.op++] = 16 | ((this.m_off >> 11) & 8) | (this.m_len - 2);
                }
                else {
                    this.m_len -= 9;
                    this.out[this.op++] = 16 | ((this.m_off >> 11) & 8);
                    while (this.m_len > 255) {
                        this.m_len -= 255;
                        this.out[this.op++] = 0;
                    }
                    this.out[this.op++] = this.m_len;
                }
                this.out[this.op++] = this.m_off << 2;
                this.out[this.op++] = this.m_off >> 6;
            }
        }
        this.t = this.ll - ((this.jj - this.ip_start) - this.ti);
    }

    compress(state: LzoState) {
        this.state = state;
        this.ip = 0;
        this.buf = this.state.inputBuffer;
        this.maxSize = this.buf.length + Math.ceil(this.buf.length / 16) + 64 + 3;
        if (this.maxSize > this.out.length) {
            this.out = new Uint8Array(this.maxSize);
        }
        this.op = 0;
        this.l = this.buf.length;
        this.t = 0;
        while (this.l > 20) {
            this.ll = this.l <= 49152 ? this.l : 49152;
            if ((this.t + this.ll) >> 5 <= 0) {
                break;
            }
            this.dict.set(this.emptyDict);
            this.prev_ip = this.ip;
            this.compressCore();
            this.ip = this.prev_ip + this.ll;
            this.l -= this.ll;
        }
        this.t += this.l;
        if (this.t > 0) {
            this.ii = this.buf.length - this.t;
            if (this.op === 0 && this.t <= 238) {
                this.out[this.op++] = 17 + this.t;
            }
            else if (this.t <= 3) {
                this.out[this.op - 2] |= this.t;
            }
            else if (this.t <= 18) {
                this.out[this.op++] = this.t - 3;
            }
            else {
                this.tt = this.t - 18;
                this.out[this.op++] = 0;
                while (this.tt > 255) {
                    this.tt -= 255;
                    this.out[this.op++] = 0;
                }
                this.out[this.op++] = this.tt;
            }
            do {
                this.out[this.op++] = this.buf[this.ii++];
            } while (--this.t > 0);
        }
        this.out[this.op++] = 17;
        this.out[this.op++] = 0;
        this.out[this.op++] = 0;
        this.state.outputBuffer = this.returnNewBuffers
            ? new Uint8Array(this.out.subarray(0, this.op))
            : this.out.subarray(0, this.op);
        return this.OK;
    }
}

const instance = new Lzo1xImpl();

export const lzo1x = {
    setBlockSize(blockSize: number) {
        return instance.setBlockSize(blockSize);
    },
    setOutputEstimate(outputSize: number) {
        return instance.setOutputSize(outputSize);
    },
    setReturnNewBuffers(value: boolean) {
        instance.setReturnNewBuffers(value);
    },
    compress(state: LzoState, cfg?: LzoConfig) {
        if (cfg !== undefined) {
            instance.applyConfig(cfg);
        }
        return instance.compress(state);
    },
    decompress(state: LzoState, cfg?: LzoConfig) {
        if (cfg !== undefined) {
            instance.applyConfig(cfg);
        }
        return instance.decompress(state);
    },
};

export type { LzoState, LzoConfig };
