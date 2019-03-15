import { ChangeChecker } from "../src/ChangeChecker";
import "mocha";

class RandomNumberGenerator {
    // tslint:disable:no-bitwise
    // tslint:disable:variable-name
    // tslint:disable:typedef

    private m_w = 123456789;
    private m_z = 987654321;
    private mask = 0xffffffff;

    constructor(seed: number) {
        this.m_w = (123456789 + seed) & this.mask;
        this.m_z = (987654321 - seed) & this.mask;
    }

    public next(min: number, max: number) {
        this.m_z = (36969 * (this.m_z & 65535) + (this.m_z >> 16)) & this.mask;
        this.m_w = (18000 * (this.m_w & 65535) + (this.m_w >> 16)) & this.mask;
        let result = ((this.m_z << 16) + (this.m_w & 65535)) >>> 0;
        result /= 4294967296;
        return Math.round(min + (result * (max - min)));
    }
}

const obj = createRandomObject(1337, 5, 15, 150);
const changeChecker = new ChangeChecker();
describe("ChangeChecker", function(): void {
    this.slow(0);
    this.timeout("50s");

    const iterations = 100;
    it(`performance takeSnapshot ${iterations} times`, () => {
        for (let index = 0; index < iterations; index++) {
            changeChecker.takeSnapshot(obj);
        }
    });

    const snapshot = changeChecker.takeSnapshot(obj);
    it(`performance createDiff ${iterations} times`, () => {
        for (let index = 0; index < iterations; index++) {
            changeChecker.createDiff(snapshot, obj);
        }
    });
});

function createRandomObject(seed: number, maxDepth: number, initialPropertyCount: number, initialArrayItemCount: number): any {
    const random = new RandomNumberGenerator(seed);
    return randomObject(random, 0, maxDepth, initialPropertyCount, initialArrayItemCount);
}

function randomString(random: RandomNumberGenerator): string {
    const chars = "abcdefghijklmnopqrstuvwxyzABZDEFGHIJKLMNOPQRSTUVWXYZ";

    const length = random.next(0, 15);
    let result = "";
    for (let i = 0; i < length; i++) {
        result += chars[random.next(0, chars.length - 1)];
    }

    return result;
}

function randomObject(random: RandomNumberGenerator, depth: number, maxDepth: number, currentMaxPropertyCount: number, currentMaxArrayItemCount: number): object {
    depth++;

    const result: any = {};
    const propertyCount = random.next(0, --currentMaxPropertyCount);
    for (let i = 0; i < propertyCount; i++) {
        result[randomString(random)] = randomAny(random, depth, maxDepth, currentMaxPropertyCount, currentMaxArrayItemCount);
    }

    return result;
}

function randomArray(random: RandomNumberGenerator, depth: number, maxDepth: number, currentMaxPropertyCount: number, currentMaxArrayItemCount: number): any[] {
    depth++;

    const result: any[] = [];
    const itemCount = random.next(0, --currentMaxArrayItemCount);
    for (let i = 0; i < itemCount; i++) {
        result[i] = randomAny(random, depth, maxDepth, currentMaxPropertyCount, currentMaxArrayItemCount);
    }
    return result;
}

function randomAny(random: RandomNumberGenerator, depth: number, maxDepth: number, currentMaxPropertyCount: number, currentMaxArrayItemCount: number): any {
    switch (random.next(depth === maxDepth ? 2 : 0, 5)) {
        case 0:
            return randomObject(random, depth, maxDepth, currentMaxPropertyCount, currentMaxArrayItemCount);
        case 1:
            return randomArray(random, depth, maxDepth, currentMaxPropertyCount, currentMaxArrayItemCount);
        case 2:
            return randomString(random);
        case 3:
            return random.next(0, 1337);
        case 4:
            return null;
        case 5:
            return undefined;
    }
}
