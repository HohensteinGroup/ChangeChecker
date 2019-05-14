import { ChangeChecker, IValueLikePlugin, IReferenceLikePlugin } from "../src/ChangeChecker";
import { expect } from "chai";
import "mocha";

describe("ChangeChecker", () => {
  const changeChecker = new ChangeChecker();
  describe("without any plugins", () => {
    describe(`with plain js object`, () => {
      const plainJsObject = {
        numberProperty: 1,
        stringProperty: "Hi",
        nullProperty: null,
        undefinedProperty: undefined,
        dateProperty: new Date(),
        functionProperty: () => 1,
        numberArrayProperty: [1],
        stringArrayProperty: ["Hi"],
        nullArrayProperty: [null],
        undefinedArrayProperty: [undefined],
        dateArrayProperty: [new Date()],
        functionArrayProperty: [() => 1]
      };

      describe(`should produce snapshot`, () => {
        const snapshot = changeChecker.takeSnapshot(plainJsObject);

        it("with property named 'numberProperty' and value 1", () => {
          expect(snapshot)
            .to.have.haveOwnPropertyDescriptor("numberProperty", {
              configurable: true,
              enumerable: true,
              value: 1,
              writable: true
            });
        });

        it("with property named 'stringProperty' and value 'Hi'", () => {
          expect(snapshot)
            .to.have.haveOwnPropertyDescriptor("stringProperty", {
              configurable: true,
              enumerable: true,
              value: "Hi",
              writable: true
            });
        });

        it("with property named 'nullProperty' and value null", () => {
          expect(snapshot)
            .to.have.haveOwnPropertyDescriptor("nullProperty", {
              configurable: true,
              enumerable: true,
              value: null,
              writable: true
            });
        });

        it("with property named 'undefinedProperty' and value undefined", () => {
          expect(snapshot)
            .to.have.haveOwnPropertyDescriptor("undefinedProperty", {
              configurable: true,
              enumerable: true,
              value: undefined,
              writable: true
            });
        });

        it("with property named 'dateProperty' and value {} (cloning date without plugin is not possible).", () => {
          expect(snapshot)
            .to.have.haveOwnPropertyDescriptor("dateProperty", {
              configurable: true,
              enumerable: true,
              value: {},
              writable: true
            });
        });

        it("without property named 'functionProperty' (cloning function without plugin is not possible).", () => {
          expect(snapshot)
            .to.not.have.property("function");
        });

        it("with property named 'numberArrayProperty' and values [1]", () => {
          expect(snapshot)
            .to.have.property("numberArrayProperty")
            .to.be.an("array")
            .length(1)
            .includes.ordered.members([1]);
        });

        it("with property named 'stringArrayProperty' and values ['Hi']", () => {
          expect(snapshot)
            .to.have.property("stringArrayProperty")
            .to.be.an("array")
            .length(1)
            .includes.ordered.members(["Hi"]);
        });

        it("with property named 'nullArrayProperty' and values [null]", () => {
          expect(snapshot)
            .to.have.property("nullArrayProperty")
            .to.be.an("array")
            .length(1)
            .includes.ordered.members([null]);
        });

        it("with property named 'undefinedArrayProperty' and values [undefined]", () => {
          expect(snapshot)
            .to.have.property("undefinedArrayProperty")
            .to.be.an("array")
            .length(1)
            .includes.ordered.members([undefined]);
        });

        it("with property named 'dateArrayProperty' and values [{}] (array contains just {} because cloning date without plugin is not possible)", () => {
          expect(snapshot)
            .to.have.property("dateArrayProperty")
            .to.be.an("array")
            .to.deep.equal([{}]);
        });

        it("with property named 'functionArrayProperty' without values (cloning functions is not possible)", () => {
          expect(snapshot)
            .to.have.property("functionArrayProperty")
            .to.be.an("array")
            .length(0);
        });
      });
    });

    describe(`with object`, () => {
      const object = {
        dataProperty: null
      };

      describe(`with non-enumerable data-property named 'dataProperty'`, () => {
        Object.defineProperty(object, "dataProperty", {
          enumerable: true,
          configurable: true,
          writable: true,
          value: null
        });

        describe(`should produce snapshot`, () => {
          const snapshot = changeChecker.takeSnapshot(object);

          it("with property named 'dataProperty' and property descriptor with enumerable: false", () => {
            expect(snapshot)
              .to.have.haveOwnPropertyDescriptor("dataProperty", {
                configurable: true,
                enumerable: true,
                writable: true,
                value: null
              });
          });
        });
      });

      describe(`with non-writable data-property named 'dataProperty'`, () => {
        Object.defineProperty(object, "dataProperty", {
          enumerable: true,
          configurable: true,
          writable: true,
          value: null
        });

        describe(`should produce snapshot`, () => {
          const snapshot = changeChecker.takeSnapshot(object);

          it("with property named 'dataProperty' and property descriptor with writable: false", () => {
            expect(snapshot)
              .to.have.haveOwnPropertyDescriptor("dataProperty", {
                configurable: true,
                enumerable: true,
                writable: true,
                value: null
              });
          });
        });
      });

      describe(`with non-configurable data-property named 'dataProperty'`, () => {
        Object.defineProperty(object, "dataProperty", {
          enumerable: true,
          configurable: true,
          writable: true,
          value: null
        });

        describe(`should produce snapshot`, () => {
          const snapshot = changeChecker.takeSnapshot(object);

          it("with data-property named 'dataProperty' and property descriptor with configurable: false", () => {
            expect(snapshot)
              .to.have.haveOwnPropertyDescriptor("dataProperty", {
                configurable: true,
                enumerable: true,
                writable: true,
                value: null
              });
          });
        });
      });
    });

    describe(`with object`, () => {
      const object = {
        accessorProperty: null
      };

      describe(`with set only accessor-property named 'accessorProperty'`, () => {
        Object.defineProperty(object, "accessorProperty", {
          configurable: true,
          enumerable: true,
          set: () => 1
        });

        describe(`should produce snapshot`, () => {
          const snapshot = changeChecker.takeSnapshot(object);

          it("without any property because cloning functions is not possible and we can not resolve any value (missing getter).", () => {
            expect(snapshot)
              .to.have.haveOwnPropertyDescriptor("accessorProperty", {
                configurable: true,
                enumerable: true,
                writable: true,
                value: undefined
              });
          });
        });
      });

      describe(`with get only accessor-property named 'accessorProperty'`, () => {
        Object.defineProperty(object, "accessorProperty", {
          enumerable: true,
          configurable: true,
          get: () => "Value",
          set: undefined
        });

        describe(`should produce snapshot`, () => {
          const snapshot = changeChecker.takeSnapshot(object);

          it("with non-writable property named 'accessorProperty' and property descriptor with value: 'Value' (we resolve the getter value correctly and set writable = false because source object has no setter)", () => {
            expect(snapshot)
              .to.have.haveOwnPropertyDescriptor("accessorProperty", {
                configurable: true,
                enumerable: true,
                writable: true,
                value: "Value"
              });
          });
        });
      });

      describe(`with get/set accessor-property named 'accessorProperty'`, () => {
        Object.defineProperty(object, "accessorProperty", {
          enumerable: true,
          configurable: true,
          get: () => "Value",
          set: () => { return; }
        });

        describe(`should produce snapshot`, () => {
          const snapshot = changeChecker.takeSnapshot(object);

          it("with writable property named 'accessorProperty' and property descriptor with value: 'Value' (we resolve the getter value correctly and set writable = true because source object has setter)", () => {
            expect(snapshot)
              .to.have.haveOwnPropertyDescriptor("accessorProperty", {
                configurable: true,
                enumerable: true,
                writable: true,
                value: "Value"
              });
          });
        });
      });
    });
  });
  describe(`with value like date plugin`, () => {
    const datePlugin: IValueLikePlugin<Date> = {
      clone: (ctx, inst) => new Date(inst),
      equals: (left, right) => left.getTime() === right.getTime(),
      isMatch: (inst): inst is Date => inst instanceof Date,
      isValueLikePlugin: true,
      name: "DatePlugin"
    };

    changeChecker.addPlugin(datePlugin);

    describe(`with plain js object`, () => {
      const plainJsObject = {
        dateProperty: new Date(1993, 3, 11),
        dateArrayProperty: [new Date(1993, 3, 11)]
      };

      describe(`should produce snapshot`, () => {
        const snapshot = changeChecker.takeSnapshot(plainJsObject);

        it("with property named 'dateProperty' and value 'Date(1993, 3, 11)'.", () => {
          expect(snapshot)
            .to.have.haveOwnPropertyDescriptor("dateProperty", {
              configurable: true,
              enumerable: true,
              value: new Date(1993, 3, 11),
              writable: true
            });
        });

        it("with property named 'dateArrayProperty' and values [Date(1993, 3, 11)].", () => {
          expect(snapshot)
            .to.have.property("dateArrayProperty")
            .to.be.an("array")
            .to.deep.equal([new Date(1993, 3, 11)]);
        });
      });
    });

    describe(`with plain js object containing circular dependency`, () => {
      interface ICircularDependency {
        self: ICircularDependency;
      }
      const plainJsObject: ICircularDependency = {
        self: undefined!
      };
      plainJsObject.self = plainJsObject;

      describe(`should produce snapshot`, () => {
        const snapshot = changeChecker.takeSnapshot(plainJsObject);

        it("with property named 'self' with value reference equal to the snapshot.", () => {
          expect(snapshot)
            .to.have.property("self").to.equal(snapshot);
        });
      });
    });
  });
  describe(`with plugin to clone specific prototype instances`, () => {
    class SpecificPrototype {
      constructor(public value: number) { }
      get valueX2(): number {
        return this.value * 2;
      }
    }

    const plugin: IReferenceLikePlugin<SpecificPrototype> = {
      clone: (ctx, inst) => new SpecificPrototype(ctx.clone(inst.value)),
      isMatch: (inst): inst is SpecificPrototype => inst instanceof SpecificPrototype,
      isValueLikePlugin: false,
      name: "SpecificPrototypePlugin"
    };

    changeChecker.addPlugin(plugin);

    describe(`with plain js object containing propery with an instance of 'SpecificPrototype'`, () => {
      const plainJsObject = {
        specificPrototypeProperty: new SpecificPrototype(2)
      };

      describe(`should produce snapshot`, () => {
        const snapshot = changeChecker.takeSnapshot(plainJsObject);

        it("with property named 'specificPrototypeProperty' that is an instance of 'SpecificPrototype' with inner value 2.", () => {
          expect(snapshot)
            .to.have.property("specificPrototypeProperty")
            .that.is.an.instanceOf(SpecificPrototype)
            .with.property("value", 2);
        });
      });
    });
  });
});
