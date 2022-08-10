import "mocha";

import { assert } from "chai";

import { ChangeChecker } from "../src/ChangeChecker";

describe("ChangeChecker", () => {
    const changeChecker = new ChangeChecker();

    describe(`and a plain js object where a child object is referenced multiple times`, () => {
        const object = {
            propertyA: "TextOld"
        };

        const plainJsObject = {
            objectPropertyA: object,
            objectPropertyB: object,
            objectArrayPropertyA: [object],
            objectArrayPropertyB: [object]
        };

        describe(`and a snapshot of this object with a mutation at the child object`, () => {
            const snapshot = changeChecker.takeSnapshot(plainJsObject);
            snapshot.objectPropertyA.propertyA = "TextNew";

            it(`should throw an error if someone tries to assign the mutated inner object to only one of the multiple references of the source object and creates a diff`, () => {
                plainJsObject.objectPropertyA = snapshot.objectPropertyA;

                assert.throws(() => changeChecker.createDiff(plainJsObject, snapshot));
            });

            it(`should NOT throw if we assign the new object using mergeSnapshotInto`, () => {
                changeChecker.mergeSnapshotInto(plainJsObject, plainJsObject, x => x.target.objectPropertyA = snapshot.objectPropertyA);

                assert.doesNotThrow(() => changeChecker.createDiff(plainJsObject, snapshot));
            });

            it(`and all references to the inner object should have been updated to the new object`, () => {
                changeChecker.mergeSnapshotInto(plainJsObject, plainJsObject, x => x.target.objectPropertyA = snapshot.objectPropertyA)

                assert.strictEqual(plainJsObject.objectPropertyA, snapshot.objectPropertyA)
                assert.strictEqual(plainJsObject.objectPropertyB, snapshot.objectPropertyA)
                for (const entry of plainJsObject.objectArrayPropertyA) {
                    assert.strictEqual(entry, snapshot.objectPropertyA)
                }
                for (const entry of plainJsObject.objectArrayPropertyB) {
                    assert.strictEqual(entry, snapshot.objectPropertyA)
                }
            })
        });
    });
});
