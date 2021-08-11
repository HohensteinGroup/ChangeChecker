# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.2.0] - 2021-08-11
### Added
- `ChangeCheckerError` and `ChangeCheckerObjectConflictError`
  - `ChangeCheckerObjectConflictError` will be thrown in case the model contains two different objects (references are not equal) with the same objectId and contains the following additional information:
    - source ("FormerModel" or "PresentModel")
    - objectId
    - conflictingObjectLeftPath (an array of strings and numbers describing the exact path)
    - conflictingObjectLeft
    - conflictingObjectRightPath (an array of strings and numbers describing the exact path)
    - conflictingObjectRight;

## [2.1.1] - 2019-12-12
### Fixed
- Fix a 'takeSnapshot' issue that leads to duplicate copies of the same object if a "reference like plugin" creates the copy of the original instance. 

## [2.1.0] - 2019-12-06
### Added
- Add '$all' property to array diff which returns $deleted, $inserted and $other concatenated.

## [2.0.1] - 2019-05-20
### Changed
- 'createDiff' throws an error in case the former model contains two different objects (references are not equal) with the same objectId. This can happen if user mix partial snapshots containing the same object at different places.

## [2.0.0] - 2019-05-14
### Changed
- Property descriptors, setters, and getters (as well as similar metadata-like features) are no more duplicated. For example, if an object is marked read-only using a property descriptor, it will be read-write in the duplicate, since that's the default condition. This has changed because it produces more **consistent** results if it comes to serialization (all properties are visible to e.g. JSON.stringify). Previously the metadata was preserved, but the properties got merged on top of the prototype chain (reconstructing the prototype chain is way to expensive). This meant enumerable properties at level two were now visible to JSON.stringify but none enumerable not. Now all properties are just visible. If necessary, we can simply introduce a mechanism to describe **which** properties should be resolved and diffed.
- 'createDiff' throws an error in case the present model contains two different objects (references are not equal) with the same objectId. This can happen if user mix partial snapshots containing the same object at different places.
- The method 'withPlugin' was renamed to 'addPlugin'
### Added
- Add method 'removePlugin'

## [1.0.4] - 2019-03-15
### Fixed
- Improve performance of "createDiff" by ~30%
- Handle edgecases if "Object.prototype" is not in the prototype chain of objects
- Ignore array entries of type "function" of present objects

## [1.0.3] - 2019-03-06
### Fixed 
- Update LICENCE
- Add missing .npmignore entries for unit test folders

## [1.0.2] - 2019-03-06
### Fixed 
- Fix dereference error if an object is deleted in the present object

## [1.0.1] - 2018-12-17
### Added 
- README: add codesandbox example

## [1.0.0] - 2018-12-12
### Added
- Initial release
