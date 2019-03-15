import "mocha";
import { assert } from "chai";
import { ChangeChecker, isPropertyDiff } from "../src/ChangeChecker";
import { State, Era } from "../src/Index";

describe("ChangeChecker", () => {
  const changeChecker = new ChangeChecker();
  describe("without any plugins and unchanged model", () => {
    const plainJsObject = {
      numberProperty: 1,
      stringProperty: "Hi",
      nullProperty: null,
      undefinedProperty: undefined,
      numberArrayProperty: [1],
      stringArrayProperty: ["Hi"],
      nullArrayProperty: [null],
      undefinedArrayProperty: [undefined]
    };
    const snapshot = changeChecker.takeSnapshot(plainJsObject);

    it("should create diff meet the following conditions", () => {
      const diff = changeChecker.createDiff(snapshot, plainJsObject);
      assert.isFalse(diff.$isChanged);
      assert.isFalse(diff.$isCreated);
      assert.isFalse(diff.$isDeleted);
      assert.strictEqual(diff.$state, State.Unchanged);
      assert.isFunction(diff.$unwrap);
      assert.isFunction(diff.$isDirty);
      assert.isFalse(diff.$isDirty());
      assert.isTrue(isPropertyDiff(diff.numberProperty));
      assert.isFalse(diff.numberProperty.$isChanged);
      assert.isFunction(diff.numberProperty.$unwrap);
      assert.strictEqual(diff.numberProperty.$unwrap(Era.Present), plainJsObject.numberProperty);
      assert.isFunction(diff.numberProperty.$isDirty);
      assert.isFalse(diff.numberProperty.$isDirty());

      assert.isTrue(isPropertyDiff(diff.stringProperty));
      assert.isTrue(isPropertyDiff(diff.nullProperty));
      assert.isTrue(isPropertyDiff(diff.undefinedProperty));
      assert.isTrue(isPropertyDiff(diff.numberArrayProperty));
      assert.isTrue(isPropertyDiff(diff.stringArrayProperty));
      assert.isTrue(isPropertyDiff(diff.nullArrayProperty));
      assert.isTrue(isPropertyDiff(diff.undefinedArrayProperty));
    });
  });
});
