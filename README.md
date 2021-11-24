# Mozilla Terraform GitHub Actions

This repository contains GitHub Actions Composite Actions used for Terraform Automation.

## Desired CI Workflow

1. Discover each Terraform module or project directory & if it has changed & iterate rest of steps on this;
2. Terraform init --backend=false, format, validate checks;
3. Required metadata checks:
    i. terraform.required_version (if Terraform instantiation code) exists;
    i. terraform.backend.gcs.prefix (if Terraform instantiation code) is same as that Terraform’s directory name;
4. Required files & documentation checks;
    i. Has README.md (though not necessarily that the README matches a terraform-docs output, to allow for edits);
    i. Warning if .terraform-version doesn’t exist;
    i. Warning if .terraform.lock.hcl doesn’t exist;
5. Security checks:
    i. secrets scanning;
    i. approved providers & modules only being used (maybe via checkov or conftest);
6. (someday goal) tflint run with cloud provider support;
7. (someday goal) Terratest style Terraform configuration unit tests demoed at least.

## Matrixify

The `mozilla/tf-actions/matrixify` action will return a list of directories that contain a versions.tf & where there has been a change in the latest git commit(s). This is useful for running a set of commands in each Terraform root directory under a given project.

Inputs:
* `default_branch`: The default branch of the repository. Defaults to main. Used for first commit on a new branch diffs.
* `filter_file`: Files to filter for as a representation of a Terraform module or project direcotry. Defaults to "version.tf".
* `ignore_dir`: Directories to filter out of the resulting matrix. Defaults to "ignoreme".
* `ignore_path`: Filepaths to filter out of the resulting matrix. Defaults to "*.ignore".

```
jobs:
  matrixify:
    name: Matrixify
    runs-on: ubuntu-latest

    steps:
    - name: Get Changed Terraform directories
      id: search
      uses: mozilla/tf-actions/matrixify@main
    - name: Outputs
      run: echo "${{ steps.search.outputs.matrix }}"
```

## CI

The `mozilla/tf-actions/ci` action will run stateless Terraform automated checks on a given Terraform root directory.

Inputs:
* `tfpath`: The directory of the Terraform project or module to run the checks on. Defaults to ".".
* `tfmodule`: Whether or not the Terrform checks are running on a module. Matches on "true" or "false". Defaults to "false".
* `workspace`: The Terraform workspace to run the checks on. Defaults to "default".

```
jobs:
  terraform-ci:
    name: Terraform CI on "${{ matrix.directory }}"
    needs: matrixify
    runs-on: ubuntu-latest
    strategy:
        matrix: ${{fromJson(needs.matrixify.outputs.matrix)}}

    steps:
    - id: terraform-checks
      name: Terraform Checks
      uses: mozilla/tf-actions/ci@main
      with:
        tfpath: ${{ matrix.directory }}
```
