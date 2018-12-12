# ChangeChecker
A typescript utility for creating generic deep typed diffs to track changes between lifecycles of objects.
- dependency free
- fast
- typed
- extensible

## Installation 
```sh
npm install change-checker
yarn add change-checker
bower install change-checker
```
## Load

### TypeScript
```typescript
import { ChangeChecker } from 'change-checker';
```

### Javascript
```javascript
var changeChecker = require('change-checker');
```

### AMD
```javascript
define(function(require,exports,module){
  var changeChecker = require('change-checker');
});
```

## How it works
### Configuration
Create an instance of the class 'ChangeChecker' and optionally add plugins as needed (more about plugins, see below).
```ts
const changeChecker = new ChangeChecker().withPlugin(new DatePlugin())
                                         .withPlugin(new DecimalPlugin());
```
### Take snapshots
To create a diff you first have to take a snapshot of your current model by calling the 'takeSnapshot' method.
```ts
const snapshot = changeChecker.takeSnapshot(model);
```
### Create the diff
After mutating your model call the method 'createDiff' providing your snapshot and the mutated model.
```ts
const diff = changeChecker.createDiff(snapshot, model);
```
### Query for changes
#### Deep dirty check
If you want to know wether anything has changed you can do a deep dirty check at any node using '$isDirty()'
```ts
diff.$isDirty(); // has anything changed?
diff.property.$isDirty() // has anything changed below a specific property?
```
#### Get more detailed information about C~~R~~UD operations done to your model
If you want to know if an array or object was created, changed or deleted use $isCreated, $isChanged, $isDeleted.
```ts
diff.$isChanged; // if true, the object has a new property, got some deleted or any value or reference to another object has changed
```
The former and present value of properties are available through $formerValue and $value.
```ts
diff.property.$value; // present value of the property
if(diff.property.$isChanged){
  const formerValue = diff.property.$formerValue // the former value of the properyt (if changed)
}
```
If the property is a value type (number, string etc.) or a "value like" (look below for "Plugin") $value and $formerValue remain of this type.
```ts
const value: string = diff.stringProperty.$value;
const decimal: Decimal = diff.decimalProperty.$value;
```
Otherwise both ($value and $formerValue) are also diffs.
```ts
const addressDiff: ObjectDiff<{  street: string; }> = diff.address.$value; // model: {  street: string; }
const isAddressChanged = addressDiff.$isChanged;
```


If you want to operate on deleted or inserted entries of the array the properties $deleted and $inserted provide this information.
```ts
diff.array.$value.$inserted;
diff.array.$value.$deleted;
```
You can unwrap the former and present model at any point using $unwrap(Era = Era.Former | Era.Present).
```ts
diff.array.$value.$inserted.map((x) => x.$unwrap(Era.Present)); // The result contains structural equal objects of all inserted entries 
diff.$unwrap(Era.Present); // The result contains the full structural equal model
```

### Example
```ts
interface ICompany {
  name: string;
  addresses: IAddress[];
}

interface IAddress {
  street: string;
}

const model!: ICompany;

const changeChecker = new ChangeChecker();
const snapshot = changeChecker.takeSnapshot(model);

// mutate model

const diff = changeChecker.createDiff(snapshot, model);

if (diff.$isDirty()) {
  if (diff.name.$isChanged) {
    // publish update name command
  }

  for (const address of diff.addresses.$value.$inserted.map((x) => x.$unwrap(Era.Present))) {
    // publish insert address command
  }

  for (const address of diff.addresses.$value.$deleted.map((x) => x.$unwrap(Era.Present))) {
    // publish delete address command
  }
}
```


## Plugins
### Value likes
Without plugins the library would create diff objects (associated with $isCreated, $isDeleted so far and so forth) for all Objects. 
This behaviour is useless for objects like Date or 3rd party libraries like decimal.js.
Those should be handeled like true values like strings, numbers etc.
To solve this issue it is possible to create 'value like' plugins. They must provide a 'clone', 'equals' and 'isMatch' function to overwrite the default equality and reference rules of javascript.

### Example
```ts
import Decimal from "decimal.js";
import { IValueLikePlugin, ICloneContext } from "change-checker";

export class DecimalPlugin implements IValueLikePlugin<Decimal> {
    public name: string = "DecimalPlugin";

    public isValueLikePlugin: true = true;

    public clone(_: ICloneContext, instance: Decimal): Decimal {
        return new Decimal(instance);
    }

    public equals(left: Decimal, right: Decimal): boolean {
        return left.equals(right);
    }

    public isMatch(instance: any): instance is Decimal {
        return instance instanceof Decimal;
    }
}

declare module "change-checker/types/ValueLikeRegistry" {
    export interface IValueLikeRegistry {
        decimal: Decimal;
    }
}

```

## Build
- clone
- yarn
- yarn build
