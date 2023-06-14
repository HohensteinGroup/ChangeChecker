// This interface is used by plugins to register their own value-like types like Date, RegExp, etc.
// Example registration:
// declare module "change-checker/types/ValueLikeRegistry" {
//     export interface IValueLikeRegistry {
//         date: Date;
//     }
// }

// This way we can get all value like types from the registry like this (see src\DiffTypes.ts):
// IValueLikeRegistry[keyof IValueLikeRegistry];

// tslint:disable-next-line:no-empty-interface => used by plugins
export interface IValueLikeRegistry { }
